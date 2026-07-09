import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { logger } from '../utils/logger.js';

interface IssuePayload {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  created_at: string;
  updated_at?: string;
  state?: string;
  comments?: number;
  labels: Array<{ name?: string | null }>;
}

// Only issues posted on the current calendar day (UTC) count as new. Older issues are
// ignored so we notify and post proposals only on freshly-posted issues.
function isCreatedToday(createdAt: string): boolean {
  return new Date(createdAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

// Short-lived cache populated by fullScan() so AutoProposalService can skip the redundant
// GET /issues/:number call — the data was already fetched during detection.
export const issueDataCache = new Map<number, { title: string; body: string; cachedAt: number }>();
const ISSUE_CACHE_TTL_MS = 2 * 60 * 1000;

export class IssuePollerService {
  // Full scan — runs every 5s (the only poll cycle).
  // Fetches ALL open issues with the watched label (no `since` filter), sorted by created date,
  // to get a complete live snapshot every cycle. A full snapshot guarantees no newly created
  // issue is missed. This detects:
  //   • Closed/unlabeled issues: in DB but absent from GitHub results → soft-delete
  //   • Brand-new issues (created today) → create records → notify + auto-propose
  //   • Field changes (title/body/comments) for tracked issues
  static async fullScan(): Promise<boolean> {
    const scanStart = Date.now();
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });
    if (!config || !config.isRunning || !config.githubToken) return false;

    const parts = config.watchedRepo.split('/');
    if (parts.length !== 2) return false;
    const [owner, repo] = parts as [string, string];

    // Daily reset
    const today = new Date().toISOString().slice(0, 10);
    if (config.dailyResetDate !== today) {
      await prisma.config.update({
        where: { id: 'singleton' },
        data: { dailySelectedCount: 0, dailyResetDate: today },
      });
      config.dailySelectedCount = 0;
      config.dailyResetDate = today;
    }

    const octokit = new Octokit({ auth: config.githubToken });

    // Paginated fetch of all currently open labeled issues, newest first by creation date
    const allIssues: IssuePayload[] = [];
    let page = 1;
    try {
      while (true) {
        const res = await octokit.request('GET /repos/{owner}/{repo}/issues', {
          owner,
          repo,
          labels: config.watchedLabel,
          state: 'open',
          sort: 'created',
          direction: 'desc',
          per_page: 100,
          page,
        });
        const batch = res.data as IssuePayload[];
        allIssues.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        logger.warn('Full scan: rate limited, aborting');
      } else {
        logger.error(err, 'Full scan: GitHub fetch failed');
      }
      return false;
    }

    const openByNum = new Map(allIssues.map((i) => [i.number, i]));

    // Load all actively tracked records
    const trackedRecords = await prisma.notificationRecord.findMany({
      where: { status: { in: ['PENDING', 'SENT'] }, deletedAt: null },
    });
    const trackedByNum = new Map(trackedRecords.map((r) => [r.githubIssueNumber, r]));

    const toCreate: Array<{
      githubIssueNumber: number;
      title: string;
      body: string;
      url: string;
      repoFullName: string;
      matchedLabel: string;
      status: 'PENDING';
      hasPendingUpdate: boolean;
      labelDetectedAt: Date;
    }> = [];
    const toSoftDelete = new Set<string>();
    const fieldUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
    let newDailyCount = config.dailySelectedCount;
    let hasNewIssues = false;
    let hasActivity = false;

    // Detect closed/unlabeled: tracked in DB but no longer in open labeled results
    for (const record of trackedRecords) {
      if (!openByNum.has(record.githubIssueNumber)) {
        toSoftDelete.add(record.id);
        logger.info({ issueNumber: record.githubIssueNumber }, 'Full scan: issue closed or label removed — soft-deleting');
      }
    }

    // Process GitHub snapshot: new issues + field sync for existing
    for (const gh of allIssues) {
      const existing = trackedByNum.get(gh.number);

      if (!existing) {
        // Brand-new issue not yet in DB — only track those posted on the current day
        if (!isCreatedToday(gh.created_at)) continue;
        if (newDailyCount >= config.issueLimit) continue;
        toCreate.push({
          githubIssueNumber: gh.number,
          title: gh.title,
          body: gh.body ?? '',
          url: gh.html_url,
          repoFullName: config.watchedRepo,
          matchedLabel: config.watchedLabel,
          status: 'PENDING' as const,
          hasPendingUpdate: false,
          labelDetectedAt: new Date(),
        });
        newDailyCount++;
        hasNewIssues = true;
        logger.info({ issueNumber: gh.number }, 'Full scan: new issue detected');
      } else if (!toSoftDelete.has(existing.id)) {
        // Existing record — sync any field changes (catches restart-gap updates)
        const titleChanged = gh.title !== existing.title;
        const bodyChanged = (gh.body ?? '') !== existing.body;
        const ghUpdatedAt = gh.updated_at ?? '';
        const storedUpdatedAt = existing.githubUpdatedAt ?? '';
        const updatedAtChanged = ghUpdatedAt !== '' && ghUpdatedAt !== storedUpdatedAt;
        const ghComments = gh.comments ?? 0;
        const commentCountChanged = ghComments !== (existing.commentCount ?? 0);
        const hasNewComments = commentCountChanged && ghComments > (existing.commentCount ?? 0);

        if (!titleChanged && !bodyChanged && !updatedAtChanged && !commentCountChanged) continue;

        const needsUpdateEmail =
          existing.status === 'SENT' &&
          storedUpdatedAt !== '' &&
          (titleChanged || bodyChanged || hasNewComments || updatedAtChanged);

        fieldUpdates.push({
          id: existing.id,
          data: {
            ...(titleChanged ? { title: gh.title } : {}),
            ...(bodyChanged ? { body: gh.body ?? '' } : {}),
            ...(commentCountChanged ? { commentCount: ghComments } : {}),
            ...(updatedAtChanged ? { githubUpdatedAt: ghUpdatedAt } : {}),
            ...(needsUpdateEmail ? { hasPendingUpdate: true } : {}),
          },
        });
        if (needsUpdateEmail) hasActivity = true;
      }
    }

    // Warm the short-lived cache so AutoProposalService can skip a redundant GET /issues/:number.
    if (toCreate.length > 0) {
      const cacheNow = Date.now();
      for (const entry of toCreate) {
        issueDataCache.set(entry.githubIssueNumber, { title: entry.title, body: entry.body, cachedAt: cacheNow });
      }
      for (const [num, cached] of issueDataCache) {
        if (cacheNow - cached.cachedAt > ISSUE_CACHE_TTL_MS) issueDataCache.delete(num);
      }
    }

    // Flush all mutations in parallel
    await Promise.all([
      toCreate.length > 0
        ? prisma.notificationRecord.createMany({ data: toCreate })
        : Promise.resolve(),

      toSoftDelete.size > 0
        ? prisma.notificationRecord.updateMany({
            where: { id: { in: [...toSoftDelete] } },
            data: { deletedAt: new Date() },
          })
        : Promise.resolve(),

      ...fieldUpdates.map(({ id, data }) =>
        prisma.notificationRecord.update({ where: { id }, data })
      ),

      newDailyCount !== config.dailySelectedCount
        ? prisma.config.update({
            where: { id: 'singleton' },
            data: { dailySelectedCount: newDailyCount },
          })
        : Promise.resolve(),
    ]);

    logger.debug(
      {
        totalMs: Date.now() - scanStart,
        newIssues: toCreate.length,
        softDeleted: toSoftDelete.size,
        fieldUpdates: fieldUpdates.length,
      },
      'Full scan complete',
    );

    return hasNewIssues || hasActivity;
  }
}

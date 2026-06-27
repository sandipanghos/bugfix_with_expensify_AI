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

const RECENTLY_CREATED_DAYS = 7;

function isRecentlyCreated(createdAt: string): boolean {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs <= RECENTLY_CREATED_DAYS * 24 * 60 * 60 * 1000;
}

// Short-lived cache populated by fastPoll() so AutoProposalService can skip the redundant
// GET /issues/:number call — the data was already fetched during detection.
export const issueDataCache = new Map<number, { title: string; body: string; cachedAt: number }>();
const ISSUE_CACHE_TTL_MS = 2 * 60 * 1000;

export class EventsPollerService {
  // Tracks the timestamp of the last fast-poll so we only fetch issues created/updated since then.
  // In-memory: resets to 5 min ago on server restart, which is a safe lookback window.
  private static lastFastPollAt: Date = new Date(Date.now() - 5 * 60 * 1000);

  // Polls GET /repos/.../issues?labels=...&since=<lastFastPollAt> every 5s.
  // Handles both new issue detection AND updates to already-tracked issues.
  static async fastPoll(): Promise<boolean> {
    const fastStart = Date.now();
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });
    if (!config || !config.isRunning) return false;

    const parts = config.watchedRepo.split('/');
    if (parts.length !== 2) return false;
    const [owner, repo] = parts as [string, string];

    const today = new Date().toISOString().slice(0, 10);
    const canCreateNew = config.dailyResetDate === today && config.dailySelectedCount < config.issueLimit;

    const since = EventsPollerService.lastFastPollAt.toISOString();
    EventsPollerService.lastFastPollAt = new Date();

    const octokit = new Octokit({ auth: config.githubToken ?? undefined });

    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        labels: config.watchedLabel,
        sort: 'updated',
        direction: 'desc',
        since,
        state: 'open',
        per_page: 20,
      });

      const issues = (response.data ?? []) as IssuePayload[];
      if (issues.length === 0) return false;

      const issueNumbers = issues.map((i) => i.number);
      const existingRecords = await prisma.notificationRecord.findMany({
        where: { githubIssueNumber: { in: issueNumbers }, deletedAt: null },
        select: {
          id: true,
          githubIssueNumber: true,
          title: true,
          body: true,
          status: true,
          githubUpdatedAt: true,
          commentCount: true,
        },
      });
      const existingByNum = new Map(existingRecords.map((r) => [r.githubIssueNumber, r]));

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
      let newDailyCount = config.dailySelectedCount;
      let hasUpdates = false;

      for (const issue of issues) {
        const existing = existingByNum.get(issue.number);

        if (!existing) {
          // ── New issue ────────────────────────────────────────────────────────
          if (!canCreateNew) continue;
          if (!isRecentlyCreated(issue.created_at)) continue;
          if (newDailyCount >= config.issueLimit) break;

          toCreate.push({
            githubIssueNumber: issue.number,
            title: issue.title,
            body: issue.body ?? '',
            url: issue.html_url,
            repoFullName: config.watchedRepo,
            matchedLabel: config.watchedLabel,
            status: 'PENDING' as const,
            hasPendingUpdate: false,
            labelDetectedAt: new Date(),
          });
          newDailyCount++;
          logger.info({ issueNumber: issue.number }, 'Fast poller: new issue detected');
        } else {
          // ── Update to existing tracked issue ─────────────────────────────────
          const titleChanged = issue.title !== existing.title;
          const bodyChanged = (issue.body ?? '') !== existing.body;
          const ghUpdatedAt = issue.updated_at ?? '';
          const storedUpdatedAt = existing.githubUpdatedAt ?? '';
          const updatedAtChanged = ghUpdatedAt !== '' && ghUpdatedAt !== storedUpdatedAt;
          const ghComments = issue.comments ?? 0;
          const commentCountChanged = ghComments !== (existing.commentCount ?? 0);
          const hasNewComments = commentCountChanged && ghComments > (existing.commentCount ?? 0);

          if (!titleChanged && !bodyChanged && !updatedAtChanged && !commentCountChanged) continue;

          const needsUpdateEmail =
            existing.status === 'SENT' &&
            storedUpdatedAt !== '' &&
            (titleChanged || bodyChanged || hasNewComments || updatedAtChanged);

          await prisma.notificationRecord.update({
            where: { id: existing.id },
            data: {
              ...(titleChanged ? { title: issue.title } : {}),
              ...(bodyChanged ? { body: issue.body ?? '' } : {}),
              ...(commentCountChanged ? { commentCount: ghComments } : {}),
              ...(updatedAtChanged ? { githubUpdatedAt: ghUpdatedAt } : {}),
              ...(needsUpdateEmail ? { hasPendingUpdate: true } : {}),
            },
          });

          if (needsUpdateEmail) {
            hasUpdates = true;
            logger.info(
              { issueNumber: issue.number, titleChanged, bodyChanged, hasNewComments, updatedAtChanged },
              'Fast poller: update detected',
            );
          }
        }
      }

      // ── Persist new records ─────────────────────────────────────────────────
      if (toCreate.length > 0) {
        const cacheNow = Date.now();
        for (const entry of toCreate) {
          issueDataCache.set(entry.githubIssueNumber, { title: entry.title, body: entry.body, cachedAt: cacheNow });
        }
        for (const [num, cached] of issueDataCache) {
          if (cacheNow - cached.cachedAt > ISSUE_CACHE_TTL_MS) issueDataCache.delete(num);
        }

        await Promise.all([
          prisma.notificationRecord.createMany({ data: toCreate }),
          newDailyCount !== config.dailySelectedCount
            ? prisma.config.update({
                where: { id: 'singleton' },
                data: { dailySelectedCount: newDailyCount },
              })
            : Promise.resolve(),
        ]);
      }

      logger.debug(
        { totalMs: Date.now() - fastStart, newIssues: toCreate.length, hasUpdates },
        'Fast poll cycle complete',
      );
      return toCreate.length > 0 || hasUpdates;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 403) {
        logger.warn('Fast poller: rate limited, backing off');
      } else if (status !== 304) {
        logger.error(err, 'Fast poller failed');
      }
      return false;
    }
  }

  // Full scan — runs every 60s.
  // Fetches ALL open issues with the watched label (no `since` filter) to get a complete
  // live snapshot. This detects:
  //   • Closed/unlabeled issues: in DB but absent from GitHub results → soft-delete
  //   • New issues missed by fast poll (restart gaps, race conditions) → create records
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

    // Paginated fetch of all currently open labeled issues
    const allIssues: IssuePayload[] = [];
    let page = 1;
    try {
      while (true) {
        const res = await octokit.request('GET /repos/{owner}/{repo}/issues', {
          owner,
          repo,
          labels: config.watchedLabel,
          state: 'open',
          sort: 'updated',
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
        // New issue not yet in DB — backup for fast poll misses (e.g. restart gaps)
        if (!isRecentlyCreated(gh.created_at)) continue;
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
        logger.info({ issueNumber: gh.number }, 'Full scan: new issue caught (fast poll miss)');
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

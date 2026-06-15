import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { isWithinNotifyWindow } from '../api/config.routes.js';

interface IssuePayload {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  created_at: string;
  labels: Array<{ name?: string | null }>;
}

interface RepoEvent {
  type?: string | null;
  payload?: {
    action?: string;
    issue?: IssuePayload;
  };
}

const RECENTLY_CREATED_DAYS = 7;

// Any IssuesEvent or IssueCommentEvent on an already-selected issue triggers an update.
// No action allow-list — new GitHub actions are automatically covered.

function isRecentlyCreated(createdAt: string): boolean {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs <= RECENTLY_CREATED_DAYS * 24 * 60 * 60 * 1000;
}

export class EventsPollerService {
  static async poll(): Promise<{ pollInterval: number; hasChanges: boolean }> {
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });

    if (!config) return { pollInterval: 60, hasChanges: false };
    if (!config.isRunning) return { pollInterval: config.pollIntervalSeconds, hasChanges: false };

    // Daily reset
    const today = new Date().toISOString().slice(0, 10);
    if (config.dailyResetDate !== today) {
      await prisma.config.update({
        where: { id: 'singleton' },
        data: { dailySelectedCount: 0, dailyResetDate: today },
      });
      config.dailySelectedCount = 0;
    }

    const parts = config.watchedRepo.split('/');
    if (parts.length !== 2) {
      logger.error({ watchedRepo: config.watchedRepo }, 'Invalid watchedRepo, expected owner/repo');
      return { pollInterval: config.pollIntervalSeconds, hasChanges: false };
    }
    const [owner, repo] = parts as [string, string];

    const octokit = new Octokit({ auth: config.githubToken ?? undefined });

    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/events', {
        owner,
        repo,
        per_page: 100, // fetch max to avoid missing events between polls
        headers: config.lastEtag ? { 'If-None-Match': config.lastEtag } : {},
      });

      if ((response as { status?: number }).status === 304) {
        logger.debug('Events poll: 304 Not Modified');
        return { pollInterval: config.pollIntervalSeconds, hasChanges: false };
      }

      const headers = response.headers as Record<string, string | undefined>;
      const newEtag = headers['etag'];
      const pollInterval = parseInt(headers['x-poll-interval'] ?? String(config.pollIntervalSeconds), 10);

      await prisma.config.update({
        where: { id: 'singleton' },
        data: {
          ...(newEtag ? { lastEtag: newEtag } : {}),
          pollIntervalSeconds: pollInterval,
        },
      });

      // Outside the notify window — ETag already saved above so these events are
      // permanently consumed and will not be replayed on the next poll.
      if (!isWithinNotifyWindow(config.notifyStartTime, config.notifyEndTime, config.notifyTimezone)) {
        logger.debug(
          { notifyStartTime: config.notifyStartTime, notifyEndTime: config.notifyEndTime, notifyTimezone: config.notifyTimezone },
          'Outside notify window — events consumed but skipped'
        );
        return { pollInterval, hasChanges: false };
      }

      const events = (response.data ?? []) as RepoEvent[];

      // Keep only the event types we care about
      const relevantEvents = events.filter(
        (e) =>
          (e.type === 'IssuesEvent' || e.type === 'IssueCommentEvent') &&
          e.payload?.issue?.number != null
      );

      if (relevantEvents.length === 0) return { pollInterval, hasChanges: false };

      // ── Single batch DB read for all issue numbers seen this cycle ───────────
      const seenNumbers = [...new Set(relevantEvents.map((e) => e.payload!.issue!.number))];

      const existingRecords = await prisma.notificationRecord.findMany({
        where: { githubIssueNumber: { in: seenNumbers } },
      });
      const byNumber = new Map(existingRecords.map((r) => [r.githubIssueNumber, r]));

      const watchedLabelLower = config.watchedLabel.toLowerCase();
      let newDailyCount = config.dailySelectedCount;

      // Mutations collected during the loop — flushed in one parallel batch after
      const toCreate: Array<{
        githubIssueNumber: number;
        title: string;
        body: string;
        url: string;
        repoFullName: string;
        matchedLabel: string;
        status: 'PENDING';
      }> = [];
      const toMarkUpdate = new Set<number>();                                   // flag-only updates (hasPendingUpdate=true)
      const toUpdateFields = new Map<number, { title?: string; body?: string }>(); // edited issues: synced fields + flag
      const createdThisCycle = new Set<number>();                               // dedup new selections within same poll

      for (const event of relevantEvents) {
        const isIssueEvent = event.type === 'IssuesEvent';
        const isCommentEvent = event.type === 'IssueCommentEvent';
        const { action, issue } = event.payload!;
        if (!action || !issue) continue;

        const existing = byNumber.get(issue.number);

        // ── New issue selection ────────────────────────────────────────────────
        // Only IssuesEvent opened/labeled, with the watched label, created ≤7 days ago
        if (isIssueEvent && (action === 'opened' || action === 'labeled')) {
          const hasWatchedLabel =
            issue.labels?.some((l) => (l.name ?? '').toLowerCase() === watchedLabelLower) ?? false;

          if (hasWatchedLabel && !existing && !createdThisCycle.has(issue.number)) {
            if (!isRecentlyCreated(issue.created_at)) {
              logger.debug({ issueNumber: issue.number }, 'Skipping stale issue (>7 days old)');
              continue;
            }
            if (newDailyCount >= config.issueLimit) {
              logger.info({ issueNumber: issue.number }, 'Daily issue limit reached, skipping');
              continue;
            }

            toCreate.push({
              githubIssueNumber: issue.number,
              title: issue.title,
              body: issue.body ?? '',
              url: issue.html_url,
              repoFullName: config.watchedRepo,
              matchedLabel: config.watchedLabel,
              status: 'PENDING',
            });
            createdThisCycle.add(issue.number);
            newDailyCount++;
            logger.info({ issueNumber: issue.number }, 'Issue selected for notification');
            continue; // brand-new record — no update queuing needed
          }
        }

        // ── Update detection ───────────────────────────────────────────────────
        // Any IssuesEvent or IssueCommentEvent action on an already-selected issue
        // triggers an update notification. Not gated on status=SENT so that updates
        // arriving while the initial email is still PENDING are not lost to ETag consumption.
        const isUpdateTrigger = isIssueEvent || isCommentEvent;

        if (isUpdateTrigger && existing && !existing.deletedAt) {
          if (action === 'edited') {
            // Detect which fields changed and sync them so emails always show current content.
            // Both checks are independent — title and body can change in the same event.
            const fields = toUpdateFields.get(issue.number) ?? {};
            if (issue.title !== existing.title) {
              fields.title = issue.title;
              logger.info({ issueNumber: issue.number, newTitle: issue.title }, 'Title changed, update queued');
            }
            if ((issue.body ?? '') !== existing.body) {
              fields.body = issue.body ?? '';
              logger.info({ issueNumber: issue.number }, 'Body changed, update queued');
            }
            if (fields.title !== undefined || fields.body !== undefined) {
              toUpdateFields.set(issue.number, fields);
            } else if (
              !existing.hasPendingUpdate &&
              !toMarkUpdate.has(issue.number) &&
              !toUpdateFields.has(issue.number)
            ) {
              // edited event but neither title nor body changed (shouldn't happen, but guard anyway)
              toMarkUpdate.add(issue.number);
            }
          } else if (
            !existing.hasPendingUpdate &&
            !toMarkUpdate.has(issue.number) &&
            !toUpdateFields.has(issue.number)
          ) {
            toMarkUpdate.add(issue.number);
            logger.info({ issueNumber: issue.number, action }, 'Update queued for notification');
          }
        }
      }

      // ── Flush all mutations in parallel ───────────────────────────────────────
      await Promise.all([
        toCreate.length > 0
          ? prisma.notificationRecord.createMany({ data: toCreate })
          : Promise.resolve(),

        toMarkUpdate.size > 0
          ? prisma.notificationRecord.updateMany({
              where: { githubIssueNumber: { in: [...toMarkUpdate] } },
              data: { hasPendingUpdate: true },
            })
          : Promise.resolve(),

        // Field-synced records: update title/body + set flag (individual updates, different values per row)
        ...Array.from(toUpdateFields.entries()).map(([issueNumber, fields]) =>
          prisma.notificationRecord.update({
            where: { githubIssueNumber: issueNumber },
            data: { ...fields, hasPendingUpdate: true },
          })
        ),

        newDailyCount !== config.dailySelectedCount
          ? prisma.config.update({
              where: { id: 'singleton' },
              data: { dailySelectedCount: newDailyCount },
            })
          : Promise.resolve(),
      ]);

      const hasChanges =
        toCreate.length > 0 || toMarkUpdate.size > 0 || toUpdateFields.size > 0;
      return { pollInterval, hasChanges };
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 304) {
        logger.debug('Events poll: 304 Not Modified (via error)');
        return { pollInterval: config.pollIntervalSeconds, hasChanges: false };
      }
      if (status === 403) {
        logger.warn('Events poll: rate limited, backing off 120s');
        return { pollInterval: 120, hasChanges: false };
      }
      logger.error(err, 'Events poll failed');
      return { pollInterval: config.pollIntervalSeconds, hasChanges: false };
    }
  }
}

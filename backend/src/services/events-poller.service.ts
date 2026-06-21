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

// Short-lived cache populated by fastPoll() so AutoProposalService can skip the redundant
// GET /issues/:number call — the data was already fetched during detection.
export const issueDataCache = new Map<number, { title: string; body: string; cachedAt: number }>();
const ISSUE_CACHE_TTL_MS = 2 * 60 * 1000;

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

    let pollInterval = config.pollIntervalSeconds;
    let eventHasChanges = false;
    let isRateLimited = false;

    // ── Events API ─────────────────────────────────────────────────────────────
    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/events', {
        owner,
        repo,
        per_page: 100, // fetch max to avoid missing events between polls
        headers: config.lastEtag ? { 'If-None-Match': config.lastEtag } : {},
      });

      const is304 = (response as { status?: number }).status === 304;
      if (is304) {
        logger.debug('Events poll: 304 Not Modified');
        // fall through — REST sync still runs below
      } else {
        // 200: process events
        const headers = response.headers as Record<string, string | undefined>;
        const newEtag = headers['etag'];
        pollInterval = parseInt(headers['x-poll-interval'] ?? String(config.pollIntervalSeconds), 10);

        await prisma.config.update({
          where: { id: 'singleton' },
          data: {
            ...(newEtag ? { lastEtag: newEtag } : {}),
            pollIntervalSeconds: pollInterval,
          },
        });

        // The notify window only controls when emails are sent (enforced in the sender).
        // The poller always creates records and syncs fields so no issue is ever permanently
        // lost just because it appeared outside the configured hours.
        const inWindow = isWithinNotifyWindow(config.notifyStartTime, config.notifyEndTime, config.notifyTimezone);
        if (!inWindow) {
          logger.debug(
            { notifyStartTime: config.notifyStartTime, notifyEndTime: config.notifyEndTime, notifyTimezone: config.notifyTimezone },
            'Outside notify window — records created/synced normally; emails held until window opens'
          );
        }

        const events = (response.data ?? []) as RepoEvent[];

        // Keep only the event types we care about
        const relevantEvents = events.filter(
          (e) =>
            (e.type === 'IssuesEvent' || e.type === 'IssueCommentEvent') &&
            e.payload?.issue?.number != null
        );

        if (relevantEvents.length > 0) {
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
            hasPendingUpdate: boolean;
            labelDetectedAt: Date;
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
            // Records are always created regardless of the notify window — the window
            // only gates email sending (enforced in the sender). This ensures issues
            // labeled during off-hours are still tracked and emailed when the window opens.
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

                const newEntry = {
                  githubIssueNumber: issue.number,
                  title: issue.title,
                  body: issue.body ?? '',
                  url: issue.html_url,
                  repoFullName: config.watchedRepo,
                  matchedLabel: config.watchedLabel,
                  status: 'PENDING' as const,
                  hasPendingUpdate: false,
                  labelDetectedAt: new Date(),
                };
                toCreate.push(newEntry);
                createdThisCycle.add(issue.number);
                newDailyCount++;
                logger.info({ issueNumber: issue.number, inWindow }, 'Issue selected for notification');

                // Expose the new record to update detection for subsequent events in this
                // same batch (e.g. a comment arriving in the same 60-second window).
                byNumber.set(issue.number, newEntry as unknown as (typeof existingRecords)[number]);
                continue; // brand-new record — update queuing handled via byNumber above
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

          // ── Merge same-batch updates into toCreate entries ────────────────────────
          for (const entry of toCreate) {
            const n = entry.githubIssueNumber;
            if (toMarkUpdate.has(n)) {
              entry.hasPendingUpdate = true;
              toMarkUpdate.delete(n);
            }
            if (toUpdateFields.has(n)) {
              const fields = toUpdateFields.get(n)!;
              if (fields.title !== undefined) entry.title = fields.title;
              if (fields.body !== undefined) entry.body = fields.body;
              entry.hasPendingUpdate = true;
              toUpdateFields.delete(n);
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

          eventHasChanges = toCreate.length > 0 || toMarkUpdate.size > 0 || toUpdateFields.size > 0;
        }
      }
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 304) {
        logger.debug('Events poll: 304 Not Modified (via error)');
        // fall through — REST sync still runs below
      } else if (status === 403) {
        logger.warn('Events poll: rate limited, backing off 120s');
        pollInterval = 120;
        isRateLimited = true;
      } else {
        logger.error(err, 'Events poll failed');
      }
    }

    // ── Direct REST sync — always runs every cycle ────────────────────────────
    // Runs after EVERY poll (200 or 304) so title/body changes are never
    // permanently missed when the Events API returns 304 (ETag consumed, no new
    // events) — which is the steady-state after a quiet period.
    // Skipped only when rate-limited (403) to avoid burning remaining quota.
    let syncHasChanges = false;
    if (config.githubToken && !isRateLimited) {
      const trackedRecords = await prisma.notificationRecord.findMany({
        where: { status: { in: ['PENDING', 'SENT'] }, deletedAt: null },
      });

      await Promise.all(
        trackedRecords.map(async (record) => {
          try {
            const ghRes = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
              owner,
              repo,
              issue_number: record.githubIssueNumber,
            });
            const gh = ghRes.data as {
              title: string;
              body?: string | null;
              comments: number;
              updated_at: string;
            };
            const titleChanged = gh.title !== record.title;
            const bodyChanged = (gh.body ?? '') !== record.body;
            const storedCommentCount = record.commentCount ?? 0;
            const commentCountChanged = gh.comments !== storedCommentCount;
            const shouldNotifyComment = commentCountChanged && gh.comments > storedCommentCount;

            // updated_at changes on ANY issue activity: new comment, edited comment,
            // label change, close/reopen, etc. Use it as the primary notification trigger.
            const storedUpdatedAt = record.githubUpdatedAt ?? '';
            const ghUpdatedAt = gh.updated_at;
            const updatedAtChanged = ghUpdatedAt !== storedUpdatedAt;
            // First sync (storedUpdatedAt=''): initialize silently; notify on all subsequent changes.
            const issueActivityDetected = updatedAtChanged && storedUpdatedAt !== '';

            const anythingChanged = titleChanged || bodyChanged || commentCountChanged || updatedAtChanged;
            if (!anythingChanged) {
              logger.debug({ issueNumber: record.githubIssueNumber }, 'REST sync: no changes');
              return;
            }

            logger.info(
              {
                issueNumber: record.githubIssueNumber,
                titleChanged,
                bodyChanged,
                commentCountChanged,
                shouldNotifyComment,
                issueActivityDetected,
                githubComments: gh.comments,
                storedUpdatedAt,
                ghUpdatedAt,
              },
              'Change detected via direct REST sync'
            );

            // Notify on: content change (title/body), new comment(s), or any other issue activity.
            const needsUpdateEmail =
              record.status === 'SENT' && (titleChanged || bodyChanged || shouldNotifyComment || issueActivityDetected);

            await prisma.notificationRecord.update({
              where: { id: record.id },
              data: {
                ...(titleChanged ? { title: gh.title } : {}),
                ...(bodyChanged ? { body: gh.body ?? '' } : {}),
                ...(commentCountChanged ? { commentCount: gh.comments } : {}),
                ...(updatedAtChanged ? { githubUpdatedAt: ghUpdatedAt } : {}),
                ...(needsUpdateEmail ? { hasPendingUpdate: true } : {}),
              },
            });

            if (needsUpdateEmail) syncHasChanges = true;
          } catch (err: unknown) {
            const s = (err as { status?: number }).status;
            if (s === 404) {
              logger.warn({ issueNumber: record.githubIssueNumber }, 'Issue not found in repo (404) — skipping REST sync');
            } else if (s !== 403) {
              logger.warn({ issueNumber: record.githubIssueNumber, status: s }, 'Direct REST sync failed');
            }
          }
        })
      );
    }

    return { pollInterval, hasChanges: eventHasChanges || syncHasChanges };
  }

  // Tracks the timestamp of the last fast-poll so we only fetch issues created/updated since then.
  // In-memory: resets to 5 min ago on server restart, which is a safe lookback window.
  private static lastFastPollAt: Date = new Date(Date.now() - 5 * 60 * 1000);

  // Polls GET /repos/.../issues?labels=...&since=<lastFastPollAt> every 5s for near-immediate
  // detection of new "Help Wanted" issues, independently of the 60s Events API interval.
  static async fastPoll(): Promise<boolean> {
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });
    if (!config || !config.isRunning) return false;

    const parts = config.watchedRepo.split('/');
    if (parts.length !== 2) return false;
    const [owner, repo] = parts as [string, string];

    // Daily reset is owned by the main poller; skip fast poll if the day hasn't been initialised yet.
    const today = new Date().toISOString().slice(0, 10);
    if (config.dailyResetDate !== today) return false;
    if (config.dailySelectedCount >= config.issueLimit) return false;

    const since = EventsPollerService.lastFastPollAt.toISOString();
    EventsPollerService.lastFastPollAt = new Date();

    const octokit = new Octokit({ auth: config.githubToken ?? undefined });

    try {
      const response = await octokit.request('GET /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        labels: config.watchedLabel,
        sort: 'created',
        direction: 'desc',
        since,
        state: 'open',
        per_page: 10,
      });

      const issues = (response.data ?? []) as IssuePayload[];
      if (issues.length === 0) return false;

      const issueNumbers = issues.map((i) => i.number);
      const existing = await prisma.notificationRecord.findMany({
        where: { githubIssueNumber: { in: issueNumbers } },
        select: { githubIssueNumber: true },
      });
      const existingNums = new Set(existing.map((r) => r.githubIssueNumber));

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

      for (const issue of issues) {
        if (existingNums.has(issue.number)) continue;
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
      }

      if (toCreate.length === 0) return false;

      // Cache issue data so AutoProposalService skips the redundant GET /issues/:number call.
      const now = Date.now();
      for (const entry of toCreate) {
        issueDataCache.set(entry.githubIssueNumber, { title: entry.title, body: entry.body, cachedAt: now });
      }

      // Evict stale entries from previous cycles to keep memory clean.
      for (const [num, cached] of issueDataCache) {
        if (now - cached.cachedAt > ISSUE_CACHE_TTL_MS) issueDataCache.delete(num);
      }

      await Promise.all([
        prisma.notificationRecord.createMany({ data: toCreate, skipDuplicates: true }),
        prisma.config.update({
          where: { id: 'singleton' },
          data: { dailySelectedCount: newDailyCount },
        }),
      ]);

      return true;
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
}

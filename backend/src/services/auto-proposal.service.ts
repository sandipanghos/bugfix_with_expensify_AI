import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { generateProposal, type GeneratedProposal } from './proposal-generator.service.js';
import {
  assertNoExistingProposal,
  assertProposalIsDifferent,
  listIssueComments,
  GuardViolationError,
} from './proposal-guards.service.js';
import { issueDataCache } from './issue-poller.service.js';

const CACHE_TTL_MS = 2 * 60 * 1000;

// Phase-1 placeholder posted the instant a new issue is detected, before the slow
// LLM analysis begins. It's edited in place with the full proposal once generation
// finishes (Phase 2). It starts with "## Proposal" so that if the process dies
// mid-flight, a later poll's assertNoExistingProposal detects our own claim and
// won't double-post. The user-visible line signals the analysis is in progress.
const CLAIM_PLACEHOLDER_BODY =
  '## Proposal\n\n_Reviewing the code and preparing a detailed root-cause analysis — this comment will be updated with the full proposal shortly._';

// Best-effort deletion of a comment; never throws (used on cleanup paths where a
// failure to delete must not mask the original error).
async function deleteCommentSafe(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> {
  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner,
      repo,
      comment_id: commentId,
    });
  } catch (err) {
    logger.warn({ err, commentId }, 'Auto-proposal: failed to remove placeholder claim comment');
  }
}

export class AutoProposalService {
  private static isRunning = false;

  static async run(): Promise<void> {
    if (AutoProposalService.isRunning) {
      logger.debug('Auto-proposal already running, skipping concurrent invocation');
      return;
    }
    AutoProposalService.isRunning = true;
    try {
      await AutoProposalService._run();
    } finally {
      AutoProposalService.isRunning = false;
    }
  }

  private static async _run(): Promise<void> {
    const runStart = Date.now();
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });

    if (!config || !config.isRunning || !config.autoProposal) return;

    if (!config.myGithubUsername) {
      logger.warn('autoProposal is enabled but myGithubUsername is not set — skipping');
      return;
    }
    if (!env.ANTHROPIC_API_KEY) {
      logger.warn('autoProposal is enabled but ANTHROPIC_API_KEY is not set — skipping');
      return;
    }
    if (!config.githubToken) {
      logger.warn('autoProposal is enabled but githubToken is not set — skipping');
      return;
    }

    const parts = config.watchedRepo.split('/');
    if (parts.length !== 2) return;
    const [owner, repo] = parts as [string, string];

    // Candidates = brand-new issues (PENDING) + already-notified issues with a pending
    // update (SENT + hasPendingUpdate): label change, body edit, or new comment. Updates
    // re-trigger a proposal attempt for issues that don't yet have one (e.g. the first
    // attempt failed, or the issue was first seen outside the daily limit window).
    const [pendingRecords, updateRecords] = await Promise.all([
      prisma.notificationRecord.findMany({
        // proposalDuplicate issues are excluded — their proposal was already blocked
        // as a near-duplicate, so re-generating would just waste an LLM call.
        where: { status: 'PENDING', deletedAt: null, proposalDuplicate: false },
        // Newest issue first, so fresh issues win the daily proposal slots before an
        // older backlog does (matters now that proposals are capped per day).
        orderBy: { createdAt: 'desc' },
      }),
      prisma.notificationRecord.findMany({
        where: { status: 'SENT', hasPendingUpdate: true, deletedAt: null, proposalDuplicate: false },
        // Most recently updated first.
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const candidates = [...pendingRecords, ...updateRecords];
    if (candidates.length === 0) return;

    // Skip issues that already have a proposal from myGithubUsername — one cheap local
    // DB query avoids re-running guards (and a GitHub comments fetch) on every update poll
    // for issues we've already proposed on (the unique constraint allows only one anyway).
    const existingProposals = await prisma.proposalRecord.findMany({
      where: {
        githubIssueNumber: { in: candidates.map((r) => r.githubIssueNumber) },
        contributorUsername: config.myGithubUsername,
      },
      select: { githubIssueNumber: true },
    });
    const alreadyProposed = new Set(existingProposals.map((p) => p.githubIssueNumber));

    // Dedup by issue number (a PENDING and SENT record can't coexist, but guard anyway)
    const seen = new Set<number>();
    const toPropose = candidates.filter((r) => {
      if (alreadyProposed.has(r.githubIssueNumber) || seen.has(r.githubIssueNumber)) return false;
      seen.add(r.githubIssueNumber);
      return true;
    });
    if (toPropose.length === 0) return;

    // Daily cap: never post more than issueLimit proposals per calendar day (UTC).
    // Without this, a backlog of tracked-but-unproposed issues flushes as a burst of
    // comments on the watched repo (e.g. 31 at once). We derive today's count from the
    // proposalRecord table (the source of truth) rather than a separate counter, so it
    // stays correct across restarts and can't drift. Remaining candidates are deferred
    // to subsequent days and drained issueLimit-at-a-time.
    const startOfDayUtc = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const postedToday = await prisma.proposalRecord.count({
      where: {
        createdAt: { gte: startOfDayUtc },
        repoFullName: config.watchedRepo,
        contributorUsername: config.myGithubUsername,
      },
    });
    const remaining = config.issueLimit - postedToday;
    if (remaining <= 0) {
      logger.info(
        { postedToday, issueLimit: config.issueLimit },
        'Auto-proposal daily limit reached — skipping until UTC reset'
      );
      return;
    }

    const capped = toPropose.slice(0, remaining);
    if (capped.length < toPropose.length) {
      logger.info(
        { posting: capped.length, deferred: toPropose.length - capped.length, postedToday, issueLimit: config.issueLimit },
        'Auto-proposal daily cap applied — deferring remaining candidates to a later day'
      );
    }

    const octokit = new Octokit({ auth: config.githubToken ?? env.GITHUB_TOKEN });

    // Each issue is fully independent — process all in parallel (bounded by the daily cap above)
    await Promise.allSettled(
      capped.map(async (record) => {
        try {
          const issueStart = Date.now();
          // Use pre-fetched data from the fast poller cache to skip a GitHub API call.
          // Falls back to a live fetch on cache miss (e.g. detected by the main Events poller).
          const cached = issueDataCache.get(record.githubIssueNumber);
          let issueTitle: string;
          let issueBody: string;

          if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
            issueTitle = cached.title;
            issueBody = cached.body;
            issueDataCache.delete(record.githubIssueNumber);
            logger.debug({ issueNumber: record.githubIssueNumber }, 'Auto-proposal: cache hit, skipped GET /issues');
          } else {
            const ghRes = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
              owner,
              repo,
              issue_number: record.githubIssueNumber,
            });
            const issue = ghRes.data as { title: string; body?: string | null; state: string };
            if (issue.state !== 'open') {
              logger.info({ issueNumber: record.githubIssueNumber }, 'Auto-proposal skipped — issue is closed');
              return;
            }
            issueTitle = issue.title;
            issueBody = issue.body ?? '';
          }

          const comments = await listIssueComments(octokit, owner, repo, record.githubIssueNumber);

          try {
            await assertNoExistingProposal(
              comments,
              record.githubIssueNumber,
              config.watchedRepo,
              config.myGithubUsername
            );
          } catch (err) {
            if (err instanceof GuardViolationError) {
              logger.info(
                { issueNumber: record.githubIssueNumber, reason: err.message },
                'Auto-proposal guard blocked'
              );
              return;
            }
            throw err;
          }

          // ── Phase 1: claim the slot NOW ────────────────────────────────────
          // Post a lightweight placeholder before the slow LLM analysis so we land
          // near the top of the thread instead of behind contributors who post
          // while we're still generating. We fetched `comments` above (before this
          // post), so the difference guard below never sees our own placeholder.
          let claimCommentId: number;
          try {
            const claimRes = await octokit.request(
              'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
              {
                owner,
                repo,
                issue_number: record.githubIssueNumber,
                body: CLAIM_PLACEHOLDER_BODY,
              }
            );
            claimCommentId = claimRes.data.id;
          } catch (err) {
            logger.error(err, `Auto-proposal: failed to post claim comment for #${record.githubIssueNumber}`);
            return;
          }
          const claimedAt = Date.now();

          // ── Phase 2: deep analysis, then edit the claim into the full proposal ─
          let generated: GeneratedProposal;
          try {
            generated = await generateProposal({
              repoFullName: config.watchedRepo,
              issueNumber: record.githubIssueNumber,
              issueTitle,
              issueBody,
              issueComments: comments.map((c) => c.body ?? '').filter(Boolean),
              issueUrl: record.url,
              octokit,
            });
            await assertProposalIsDifferent(comments, generated);
          } catch (err) {
            // Generation failed or the proposal is a near-duplicate — withdraw the
            // placeholder so we don't leave a hollow claim on the issue.
            await deleteCommentSafe(octokit, owner, repo, claimCommentId);
            if (err instanceof GuardViolationError) {
              // A GuardViolationError here can only come from assertProposalIsDifferent
              // (generateProposal never throws it), so this issue's proposal duplicates
              // one already on the thread. Flag it so we stop emailing updates about it
              // and stop re-running the (expensive) generation on every future update.
              await prisma.notificationRecord.update({
                where: { id: record.id },
                data: { proposalDuplicate: true, hasPendingUpdate: false },
              });
              logger.info(
                { issueNumber: record.githubIssueNumber, reason: err.message },
                'Auto-proposal near-duplicate — claim withdrawn, issue flagged (update emails + retries suppressed)'
              );
              return;
            }
            throw err;
          }

          let editRes;
          try {
            editRes = await octokit.request(
              'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
              {
                owner,
                repo,
                comment_id: claimCommentId,
                body: generated.commentBody,
              }
            );
          } catch (err) {
            // The edit failed, so the placeholder is still hollow. Remove it so a
            // later poll can retry cleanly — otherwise the leftover "## Proposal"
            // claim would trip assertNoExistingProposal and block this issue forever.
            await deleteCommentSafe(octokit, owner, repo, claimCommentId);
            throw err;
          }

          await prisma.proposalRecord.create({
            data: {
              githubIssueNumber: record.githubIssueNumber,
              repoFullName: config.watchedRepo,
              contributorUsername: config.myGithubUsername,
              rootCause: generated.rootCause,
              proposedChange: generated.proposedChange,
              alternatives: generated.alternatives,
              commentBody: generated.commentBody,
              commentUrl: editRes.data.html_url,
              commentId: BigInt(editRes.data.id),
            },
          });

          logger.info(
            {
              issueNumber: record.githubIssueNumber,
              commentUrl: editRes.data.html_url,
              claimMs: claimedAt - issueStart,
              generateMs: Date.now() - claimedAt,
              durationMs: Date.now() - issueStart,
            },
            'Auto-proposal posted (two-phase claim + edit)'
          );
        } catch (err) {
          logger.error(err, `Auto-proposal failed for issue #${record.githubIssueNumber}`);
        }
      })
    );

    logger.info({ totalMs: Date.now() - runStart, issueCount: toPropose.length }, 'Auto-proposal run complete');
  }
}

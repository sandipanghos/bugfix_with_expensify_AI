import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { generateProposal } from './proposal-generator.service.js';
import {
  assertNoExistingProposal,
  assertProposalIsDifferent,
  listIssueComments,
  GuardViolationError,
} from './proposal-guards.service.js';
import { issueDataCache } from './events-poller.service.js';

const CACHE_TTL_MS = 2 * 60 * 1000;

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
        where: { status: 'PENDING', deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.notificationRecord.findMany({
        where: { status: 'SENT', hasPendingUpdate: true, deletedAt: null },
        orderBy: { updatedAt: 'asc' },
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

    const octokit = new Octokit({ auth: config.githubToken ?? env.GITHUB_TOKEN });

    // Each issue is fully independent — process all in parallel
    await Promise.allSettled(
      toPropose.map(async (record) => {
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

          const generated = await generateProposal({
            repoFullName: config.watchedRepo,
            issueNumber: record.githubIssueNumber,
            issueTitle,
            issueBody,
            issueComments: comments.map((c) => c.body ?? '').filter(Boolean),
            issueUrl: record.url,
            octokit,
          });

          try {
            await assertProposalIsDifferent(comments, generated.rootCause);
          } catch (err) {
            if (err instanceof GuardViolationError) {
              logger.info(
                { issueNumber: record.githubIssueNumber, reason: err.message },
                'Auto-proposal duplicate root cause — skipping'
              );
              return;
            }
            throw err;
          }

          const postRes = await octokit.request(
            'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
            {
              owner,
              repo,
              issue_number: record.githubIssueNumber,
              body: generated.commentBody,
            }
          );

          await prisma.proposalRecord.create({
            data: {
              githubIssueNumber: record.githubIssueNumber,
              repoFullName: config.watchedRepo,
              contributorUsername: config.myGithubUsername,
              rootCause: generated.rootCause,
              proposedChange: generated.proposedChange,
              alternatives: generated.alternatives,
              commentBody: generated.commentBody,
              commentUrl: postRes.data.html_url,
              commentId: BigInt(postRes.data.id),
            },
          });

          logger.info(
            { issueNumber: record.githubIssueNumber, commentUrl: postRes.data.html_url, durationMs: Date.now() - issueStart },
            'Auto-proposal posted'
          );
        } catch (err) {
          logger.error(err, `Auto-proposal failed for issue #${record.githubIssueNumber}`);
        }
      })
    );

    logger.info({ totalMs: Date.now() - runStart, issueCount: toPropose.length }, 'Auto-proposal run complete');
  }
}

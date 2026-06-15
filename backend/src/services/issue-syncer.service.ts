import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { logger } from '../utils/logger.js';

// Directly polls the GitHub REST API for each tracked issue to detect title/body
// changes that the Events API missed (delays, fork event quirks, poll failures).
// Returns true when any record was updated so the caller can fire the sender immediately.

export class IssueSyncerService {
  static async sync(): Promise<boolean> {
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });
    if (!config || !config.isRunning) return false;

    if (!config.githubToken) {
      logger.debug('Issue syncer skipped — no GitHub token configured (unauthenticated rate limit too low for per-issue polling)');
      return false;
    }

    const parts = config.watchedRepo.split('/');
    if (parts.length !== 2) return false;
    const [owner, repo] = parts as [string, string];

    const records = await prisma.notificationRecord.findMany({
      where: { deletedAt: null, status: { in: ['PENDING', 'SENT'] } },
    });

    if (records.length === 0) return false;

    logger.debug({ count: records.length }, 'Issue syncer: checking tracked issues for changes');

    const octokit = new Octokit({ auth: config.githubToken });

    let hasChanges = false;

    await Promise.all(
      records.map(async (record) => {
        try {
          const ghRes = await octokit.request(
            'GET /repos/{owner}/{repo}/issues/{issue_number}',
            { owner, repo, issue_number: record.githubIssueNumber }
          );

          const issue = ghRes.data as { title: string; body?: string | null };
          const newTitle = issue.title;
          const newBody = issue.body ?? '';

          const titleChanged = newTitle !== record.title;
          const bodyChanged = newBody !== record.body;

          if (!titleChanged && !bodyChanged) return;

          logger.info(
            { issueNumber: record.githubIssueNumber, titleChanged, bodyChanged },
            'Issue change detected via REST sync'
          );

          await prisma.notificationRecord.update({
            where: { id: record.id },
            data: {
              ...(titleChanged ? { title: newTitle } : {}),
              ...(bodyChanged ? { body: newBody } : {}),
              // SENT records: flag for update email
              // PENDING records: only refresh content — update email follows initial automatically
              ...(record.status === 'SENT' ? { hasPendingUpdate: true } : {}),
            },
          });

          hasChanges = true;
        } catch (err: unknown) {
          const status = (err as { status?: number }).status;
          if (status === 404) {
            logger.warn({ issueNumber: record.githubIssueNumber }, 'Issue not found during REST sync, skipping');
            return;
          }
          if (status === 403) {
            logger.warn('Issue syncer rate limited, will retry next cycle');
            return;
          }
          logger.error(err, `REST sync failed for issue #${record.githubIssueNumber}`);
        }
      })
    );

    return hasChanges;
  }
}

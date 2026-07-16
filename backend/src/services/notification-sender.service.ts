import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { sendIssueNotification } from './email.service.js';
import { isWithinNotifyWindow } from '../api/config.routes.js';
import { listIssueComments, proposalHasNearDuplicate } from './proposal-guards.service.js';

export class NotificationSenderService {
  // Prevents two concurrent send() calls from running the same batch in parallel,
  // which would cause duplicate update emails for the same hasPendingUpdate record.
  private static isSending = false;

  static async send(): Promise<void> {
    if (NotificationSenderService.isSending) {
      logger.debug('Sender already running, skipping concurrent invocation');
      return;
    }
    NotificationSenderService.isSending = true;
    try {
      await NotificationSenderService._send();
    } finally {
      NotificationSenderService.isSending = false;
    }
  }

  private static async _send(): Promise<void> {
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });

    if (!config || !config.isRunning || !config.notificationEmail) return;

    // Safety net: the poller still syncs field changes outside the window, but
    // emails must only go out inside the window.
    if (!isWithinNotifyWindow(config.notifyStartTime, config.notifyEndTime, config.notifyTimezone)) {
      logger.debug(
        { notifyStartTime: config.notifyStartTime, notifyEndTime: config.notifyEndTime, notifyTimezone: config.notifyTimezone },
        'Outside notify window — skipping email send'
      );
      return;
    }

    // Fetch both pending sets in one round-trip
    const [pending, pendingUpdates] = await Promise.all([
      prisma.notificationRecord.findMany({
        where: { status: 'PENDING', deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.notificationRecord.findMany({
        // Skip issues whose proposal was flagged a near-duplicate — no update emails.
        where: { status: 'SENT', hasPendingUpdate: true, deletedAt: null, proposalDuplicate: false },
        orderBy: { updatedAt: 'asc' },
      }),
    ]);

    // Send initial notifications and update notifications in parallel
    await Promise.all([
      ...pending.map(async (record) => {
        try {
          const smtpStart = Date.now();
          await sendIssueNotification({
            to: config.notificationEmail,
            issueTitle: record.title,
            issueUrl: record.url,
            issueNumber: record.githubIssueNumber,
            matchedLabel: record.matchedLabel,
            repoFullName: record.repoFullName,
            issueBody: record.body || undefined,
            isUpdate: false,
          });
          const smtpMs = Date.now() - smtpStart;

          const now = new Date();
          await prisma.notificationRecord.update({
            where: { id: record.id },
            data: {
              status: 'SENT',
              notifiedAt: now,
              attempts: { increment: 1 },
              lastAttemptAt: now,
            },
          });

          const lagMs = record.labelDetectedAt ? now.getTime() - record.labelDetectedAt.getTime() : null;
          logger.info(
            { issueNumber: record.githubIssueNumber, smtpMs, lagMs },
            'Initial notification sent'
          );
        } catch (err) {
          await prisma.notificationRecord.update({
            where: { id: record.id },
            data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
          });
          logger.error(err, `Failed to send notification for issue #${record.githubIssueNumber}, will retry next poll cycle`);
        }
      }),

      ...pendingUpdates.map(async (record) => {
        const updateCount = record.updateEmailCount + 1;
        try {
          // Update notifications only go to issues that already have a proposal comment
          // posted. If no proposal exists for this issue, clear the flag and skip the email.
          const hasProposal = await prisma.proposalRecord.findFirst({
            where: {
              githubIssueNumber: record.githubIssueNumber,
              ...(config.myGithubUsername ? { contributorUsername: config.myGithubUsername } : {}),
            },
          });
          if (!hasProposal) {
            await prisma.notificationRecord.update({
              where: { id: record.id },
              data: { hasPendingUpdate: false },
            });
            logger.info(
              { issueNumber: record.githubIssueNumber },
              'Update notification skipped — no proposal comment posted for this issue'
            );
            return;
          }

          // Suppress the update email if our posted proposal is now a near-duplicate
          // (≥98% identical) of another contributor's proposal on the issue. Persist
          // proposalDuplicate so future updates skip the GitHub round-trip entirely.
          if (config.githubToken && config.myGithubUsername) {
            const [dupOwner, dupRepo] = record.repoFullName.split('/');
            if (dupOwner && dupRepo) {
              try {
                const octokit = new Octokit({ auth: config.githubToken });
                const comments = await listIssueComments(octokit, dupOwner, dupRepo, record.githubIssueNumber);
                const isDup = proposalHasNearDuplicate(
                  comments,
                  {
                    rootCause: hasProposal.rootCause,
                    proposedChange: hasProposal.proposedChange,
                    alternatives: hasProposal.alternatives,
                  },
                  config.myGithubUsername
                );
                if (isDup) {
                  await prisma.notificationRecord.update({
                    where: { id: record.id },
                    data: { hasPendingUpdate: false, proposalDuplicate: true },
                  });
                  logger.info(
                    { issueNumber: record.githubIssueNumber },
                    'Update notification skipped — proposal is a near-duplicate of another on the issue'
                  );
                  return;
                }
              } catch (dupErr) {
                // Non-fatal: if the duplicate check fails (e.g. GitHub rate limit),
                // fall through and send the email rather than silently dropping it.
                logger.warn(
                  { err: dupErr, issueNumber: record.githubIssueNumber },
                  'Duplicate check failed before update email — sending anyway'
                );
              }
            }
          }

          const smtpStart = Date.now();
          await sendIssueNotification({
            to: config.notificationEmail,
            issueTitle: record.title,
            issueUrl: record.url,
            issueNumber: record.githubIssueNumber,
            matchedLabel: record.matchedLabel,
            repoFullName: record.repoFullName,
            issueBody: record.body || undefined,
            isUpdate: true,
            updateCount,
          });
          const smtpMs = Date.now() - smtpStart;

          await prisma.notificationRecord.update({
            where: { id: record.id },
            data: {
              hasPendingUpdate: false,
              updateEmailCount: { increment: 1 },
              lastUpdateEmailAt: new Date(),
            },
          });

          logger.info({ issueNumber: record.githubIssueNumber, updateCount, smtpMs }, 'Update notification sent');
        } catch (err) {
          // hasPendingUpdate stays true — retried automatically on next 20s cycle
          logger.error(err, `Failed to send update notification for issue #${record.githubIssueNumber}, will retry next poll cycle`);
        }
      }),
    ]);
  }
}

import { prisma } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { sendIssueNotification } from './email.service.js';
import { isWithinNotifyWindow } from '../api/config.routes.js';

export class NotificationSenderService {
  static async send(): Promise<void> {
    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });

    if (!config || !config.isRunning || !config.notificationEmail) return;

    // Safety net: poller already skips events outside the window, but a record
    // created right at the window boundary could still be PENDING when the window
    // closes. Don't send it — it will be cleared on the next daily reset or the
    // user can hard-delete it manually.
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
        where: { status: 'SENT', hasPendingUpdate: true, deletedAt: null },
        orderBy: { updatedAt: 'asc' },
      }),
    ]);

    // Send initial notifications and update notifications in parallel
    await Promise.all([
      ...pending.map(async (record) => {
        try {
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

          await prisma.notificationRecord.update({
            where: { id: record.id },
            data: {
              status: 'SENT',
              notifiedAt: new Date(),
              attempts: { increment: 1 },
              lastAttemptAt: new Date(),
            },
          });

          logger.info({ issueNumber: record.githubIssueNumber }, 'Initial notification sent');
        } catch (err) {
          await prisma.notificationRecord.update({
            where: { id: record.id },
            data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
          });
          logger.error(err, `Failed to send notification for issue #${record.githubIssueNumber}, will retry in 20s`);
        }
      }),

      ...pendingUpdates.map(async (record) => {
        const updateCount = record.updateEmailCount + 1;
        try {
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

          await prisma.notificationRecord.update({
            where: { id: record.id },
            data: {
              hasPendingUpdate: false,
              updateEmailCount: { increment: 1 },
              lastUpdateEmailAt: new Date(),
            },
          });

          logger.info({ issueNumber: record.githubIssueNumber, updateCount }, 'Update notification sent');
        } catch (err) {
          // hasPendingUpdate stays true — retried automatically on next 20s cycle
          logger.error(err, `Failed to send update notification for issue #${record.githubIssueNumber}, will retry in 20s`);
        }
      }),
    ]);
  }
}

import { logger } from '../utils/logger.js';
import { EventsPollerService } from '../services/events-poller.service.js';
import { NotificationSenderService } from '../services/notification-sender.service.js';

let pollerTimer: ReturnType<typeof setTimeout> | null = null;

export function startSchedulers(): void {
  startEventsPoller();
  logger.info('Schedulers started (Events poller: dynamic interval)');
}

function startEventsPoller(): void {
  async function runAndReschedule() {
    try {
      const { pollInterval, hasChanges } = await EventsPollerService.poll();
      logger.debug({ pollInterval, hasChanges }, 'Events poller cycle complete, rescheduling');

      // Always drain the send queue after every poll cycle — covers new issues,
      // updates, retries of failed sends, and window-delayed emails.
      NotificationSenderService.send().catch((err) =>
        logger.error(err, 'Email send after poller failed')
      );

      pollerTimer = setTimeout(runAndReschedule, pollInterval * 1000);
    } catch (err) {
      logger.error(err, 'Unhandled error in events poller, retrying in 60s');
      pollerTimer = setTimeout(runAndReschedule, 60_000);
    }
  }

  // First run after a short delay to let the server finish starting
  pollerTimer = setTimeout(runAndReschedule, 2_000);
}

export function stopSchedulers(): void {
  if (pollerTimer) {
    clearTimeout(pollerTimer);
    pollerTimer = null;
  }
  logger.info('Schedulers stopped');
}

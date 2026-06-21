import { logger } from '../utils/logger.js';
import { EventsPollerService } from '../services/events-poller.service.js';
import { NotificationSenderService } from '../services/notification-sender.service.js';
import { AutoProposalService } from '../services/auto-proposal.service.js';

let pollerTimer: ReturnType<typeof setTimeout> | null = null;
let fastPollerTimer: ReturnType<typeof setTimeout> | null = null;

export function startSchedulers(): void {
  startEventsPoller();
  startFastPoller();
  logger.info('Schedulers started (Events poller: dynamic interval, Fast poller: 5s)');
}

function startEventsPoller(): void {
  async function runAndReschedule() {
    try {
      const { pollInterval, hasChanges } = await EventsPollerService.poll();
      logger.debug({ pollInterval, hasChanges }, 'Events poller cycle complete, rescheduling');

      // Fire email sender and auto-proposal in parallel — fully independent,
      // neither blocks nor depends on the other.
      NotificationSenderService.send().catch((err) =>
        logger.error(err, 'Email send after poller failed')
      );
      AutoProposalService.run().catch((err) =>
        logger.error(err, 'Auto-proposal after poller failed')
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

function startFastPoller(): void {
  async function runAndReschedule() {
    try {
      const hasNew = await EventsPollerService.fastPoll();
      if (hasNew) {
        NotificationSenderService.send().catch((err) =>
          logger.error(err, 'Email send after fast poller failed')
        );
        AutoProposalService.run().catch((err) =>
          logger.error(err, 'Auto-proposal after fast poller failed')
        );
      }
    } catch (err) {
      logger.error(err, 'Unhandled error in fast poller');
    }
    fastPollerTimer = setTimeout(runAndReschedule, 5_000);
  }

  // Stagger start slightly so fast poller and main poller don't both fire at t=2s
  fastPollerTimer = setTimeout(runAndReschedule, 4_000);
}

export function stopSchedulers(): void {
  if (pollerTimer) {
    clearTimeout(pollerTimer);
    pollerTimer = null;
  }
  if (fastPollerTimer) {
    clearTimeout(fastPollerTimer);
    fastPollerTimer = null;
  }
  logger.info('Schedulers stopped');
}

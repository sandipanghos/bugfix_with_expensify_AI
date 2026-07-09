import { logger } from '../utils/logger.js';
import { IssuePollerService } from '../services/issue-poller.service.js';
import { NotificationSenderService } from '../services/notification-sender.service.js';
import { AutoProposalService } from '../services/auto-proposal.service.js';

let pollerTimer: ReturnType<typeof setTimeout> | null = null;

const POLL_MS = 5_000; // full snapshot scan — runs every 5s so no new issue is missed

export function startSchedulers(): void {
  startPoller();
  logger.info(`Schedulers started (full scan poll: ${POLL_MS / 1000}s)`);
}

// Full snapshot scan every 5s using GET /repos/issues?labels=...&state=open (sorted by created
// date, no `since` filter). A complete snapshot every cycle guarantees no newly created issue is
// missed. Detects: closed/unlabeled issues (absent from results → soft-delete), brand-new issues
// (→ create records), and field changes for existing tracked issues. Triggers notification +
// auto-proposal immediately on any new activity.
function startPoller(): void {
  async function runAndReschedule() {
    try {
      const hasActivity = await IssuePollerService.fullScan();
      if (hasActivity) {
        NotificationSenderService.send().catch((err) =>
          logger.error(err, 'Email send after full scan failed'),
        );
        AutoProposalService.run().catch((err) =>
          logger.error(err, 'Auto-proposal after full scan failed'),
        );
      }
    } catch (err) {
      logger.error(err, 'Unhandled error in poller');
    }
    pollerTimer = setTimeout(() => void runAndReschedule(), POLL_MS);
  }

  pollerTimer = setTimeout(() => void runAndReschedule(), 2_000);
}

export function stopSchedulers(): void {
  if (pollerTimer) { clearTimeout(pollerTimer); pollerTimer = null; }
  logger.info('Schedulers stopped');
}

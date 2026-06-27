import { logger } from '../utils/logger.js';
import { EventsPollerService } from '../services/events-poller.service.js';
import { NotificationSenderService } from '../services/notification-sender.service.js';
import { AutoProposalService } from '../services/auto-proposal.service.js';

let fastPollerTimer: ReturnType<typeof setTimeout> | null = null;
let fullScanTimer: ReturnType<typeof setTimeout> | null = null;

const FAST_POLL_MS  =  5_000; // issue search poll (label detection + updates) — runs every 5s
const FULL_SCAN_MS  = 60_000; // closure/catchup scan — runs every 60s

export function startSchedulers(): void {
  startFastPoller();
  startFullScanner();
  logger.info(`Schedulers started (fast poll: ${FAST_POLL_MS / 1000}s, full scan: ${FULL_SCAN_MS / 1000}s)`);
}

// Polls for new/updated issues with the watched label every 5s.
// Triggers notification + auto-proposal immediately on any new activity.
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
    fastPollerTimer = setTimeout(runAndReschedule, FAST_POLL_MS);
  }

  // Stagger first run so fast poller and full scan don't fire simultaneously at startup.
  fastPollerTimer = setTimeout(runAndReschedule, 2_000);
}

// Full snapshot scan every 60s using GET /repos/issues?labels=...&state=open (no `since` filter).
// Detects: closed/unlabeled issues (absent from results → soft-delete), new issues missed by fast
// poll (restart gaps), and field changes for existing tracked issues.
function startFullScanner(): void {
  async function runAndReschedule() {
    try {
      const hasActivity = await EventsPollerService.fullScan();
      if (hasActivity) {
        NotificationSenderService.send().catch((err) =>
          logger.error(err, 'Email send after full scan failed')
        );
        AutoProposalService.run().catch((err) =>
          logger.error(err, 'Auto-proposal after full scan failed')
        );
      }
    } catch (err) {
      logger.error(err, 'Unhandled error in full scan');
    }
    fullScanTimer = setTimeout(runAndReschedule, FULL_SCAN_MS);
  }

  // First full scan runs 10s after startup (after fast poller has had a few cycles).
  fullScanTimer = setTimeout(runAndReschedule, 10_000);
}

export function stopSchedulers(): void {
  if (fastPollerTimer) { clearTimeout(fastPollerTimer); fastPollerTimer = null; }
  if (fullScanTimer)   { clearTimeout(fullScanTimer);   fullScanTimer   = null; }
  logger.info('Schedulers stopped');
}

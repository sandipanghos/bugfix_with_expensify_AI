import { createApp } from './app.js';
import { env } from './utils/env.js';
import { logger } from './utils/logger.js';
import { connectDatabase } from './db/client.js';
import { startSchedulers } from './jobs/schedulers.js';
import { prisma } from './db/client.js';
import { DEFAULT_CONFIG } from './api/config.routes.js';

async function main() {
  await connectDatabase();

  const now = new Date();

  // Read stored timezone so we format the restart time in the user's zone.
  const existing = await prisma.config.findUnique({ where: { id: 'singleton' } });
  const timezone = existing?.notifyTimezone || 'UTC';

  // Format current time as HH:MM in the configured timezone.
  const tp = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hh = (tp.find((p) => p.type === 'hour')?.value ?? '00').padStart(2, '0');
  const mm = (tp.find((p) => p.type === 'minute')?.value ?? '00').padStart(2, '0');
  const notifyStartTime = `${hh}:${mm}`;

  // On every restart: auto-start the service, stamp restart time, and open the
  // notification window from this exact moment so no stale emails fire for the
  // period the server was down.
  await prisma.config.upsert({
    where: { id: 'singleton' },
    create: { ...DEFAULT_CONFIG, isRunning: true, lastRestartAt: now, notifyStartTime },
    update: { isRunning: true, lastRestartAt: now, notifyStartTime },
  });
  logger.info({ lastRestartAt: now.toISOString(), notifyStartTime }, 'Service auto-started on boot');

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'Server started');
  });

  startSchedulers();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error(err, 'Fatal startup error');
  process.exit(1);
});

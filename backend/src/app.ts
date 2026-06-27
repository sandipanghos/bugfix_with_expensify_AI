import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { configRouter } from './api/config.routes.js';
import { notificationsRouter } from './api/notifications.routes.js';
import { proposalsRouter } from './api/proposals.routes.js';
import { healthRouter } from './api/health.routes.js';
import { errorHandler } from './middleware/error.middleware.js';
import { notFoundHandler } from './middleware/not-found.middleware.js';
import { env } from './utils/env.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api', limiter);

  app.use(express.json({ limit: '10kb' }));
  // BigInt values (e.g. GitHub comment IDs) can't be JSON-serialized natively.
  // Express uses this replacer in every res.json() call.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? Number(value) : value,
  );

  app.use((req, _res, next) => {
    logger.info({ method: req.method, url: req.url }, 'Request');
    next();
  });

  app.use('/health', healthRouter);
  app.use('/api/config', configRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/proposals', proposalsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

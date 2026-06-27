import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { logger } from '../utils/logger.js';

export const configRouter = Router();

export function isWithinNotifyWindow(startTime: string, endTime: string, timezone: string): boolean {
  if (!startTime || !endTime) return true; // no filter configured — always notify
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const current = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    // Normal window (09:00–17:00) or overnight window (22:00–06:00)
    return startTime <= endTime
      ? current >= startTime && current <= endTime
      : current >= startTime || current <= endTime;
  } catch {
    return true; // invalid timezone — don't block notifications
  }
}

export const DEFAULT_CONFIG = {
  id: 'singleton',
  notificationEmail: '',
  watchedRepo: 'sandipanghos/App',
  watchedLabel: 'Help Wanted',
  issueLimit: 4,
  githubToken: null,
  lastEtag: null,
  pollIntervalSeconds: 60,
  dailySelectedCount: 0,
  dailyResetDate: '',
  isRunning: false,
  notifyStartTime: '',
  notifyEndTime: '',
  notifyTimezone: 'UTC',
  myGithubUsername: '',
  autoProposal: false,
};

// HH:MM or empty string
const timeSchema = z
  .string()
  .regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM (00:00–23:59) or empty string');

const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid IANA timezone (e.g. UTC, Asia/Kolkata, America/New_York)' }
);

async function getOrCreateConfig() {
  return prisma.config.upsert({
    where: { id: 'singleton' },
    create: DEFAULT_CONFIG,
    update: {},
  });
}

// GET /api/config
configRouter.get('/', async (_req, res, next) => {
  try {
    const config = await getOrCreateConfig();
    const { githubToken: _token, lastEtag: _etag, ...safe } = config;
    res.json({ config: safe, hasGithubToken: !!config.githubToken });
  } catch (err) {
    next(err);
  }
});

const updateConfigSchema = z.object({
  notificationEmail: z.string().email().optional(),
  watchedRepo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'Must be in owner/repo format')
    .optional(),
  watchedLabel: z.string().min(1).optional(),
  issueLimit: z.coerce.number().int().min(1).max(100).optional(),
  githubToken: z.string().min(1).nullable().optional(),
  notifyStartTime: timeSchema.optional(),
  notifyEndTime: timeSchema.optional(),
  notifyTimezone: timezoneSchema.optional(),
  myGithubUsername: z.string().optional(),
  autoProposal: z.boolean().optional(),
});

// PUT /api/config
configRouter.put('/', async (req, res, next) => {
  try {
    const body = updateConfigSchema.parse(req.body);
    const current = await getOrCreateConfig();
    const repoChanged = body.watchedRepo && body.watchedRepo !== current.watchedRepo;

    const updated = await prisma.config.upsert({
      where: { id: 'singleton' },
      create: { ...DEFAULT_CONFIG, ...body },
      update: {
        ...body,
        ...(repoChanged ? { lastEtag: null, dailySelectedCount: 0, dailyResetDate: '' } : {}),
      },
    });

    const { githubToken: _token, lastEtag: _etag, ...safe } = updated;
    logger.info('Config updated');
    res.json({ config: safe, hasGithubToken: !!updated.githubToken });
  } catch (err) {
    next(err);
  }
});

// GET /api/config/status
configRouter.get('/status', async (_req, res, next) => {
  try {
    const config = await getOrCreateConfig();
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      isRunning: config.isRunning,
      watchedRepo: config.watchedRepo,
      watchedLabel: config.watchedLabel,
      issueLimit: config.issueLimit,
      notificationEmail: config.notificationEmail,
      dailySelectedCount: config.dailySelectedCount,
      isNewDay: config.dailyResetDate !== today,
      pollIntervalSeconds: config.pollIntervalSeconds,
      hasGithubToken: !!config.githubToken,
      notifyStartTime: config.notifyStartTime,
      notifyEndTime: config.notifyEndTime,
      notifyTimezone: config.notifyTimezone,
      isInNotifyWindow: isWithinNotifyWindow(config.notifyStartTime, config.notifyEndTime, config.notifyTimezone),
      myGithubUsername: config.myGithubUsername,
      autoProposal: config.autoProposal,
      lastRestartAt: config.lastRestartAt,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/config/start
configRouter.post('/start', async (_req, res, next) => {
  try {
    const config = await getOrCreateConfig();

    if (!config.notificationEmail) {
      res.status(400).json({ error: 'notificationEmail must be set before starting' });
      return;
    }

    await prisma.config.update({ where: { id: 'singleton' }, data: { isRunning: true } });
    logger.info('Notification service started');
    res.json({ status: 'running', message: 'Notification service started' });
  } catch (err) {
    next(err);
  }
});

// POST /api/config/stop
configRouter.post('/stop', async (_req, res, next) => {
  try {
    await prisma.config.update({ where: { id: 'singleton' }, data: { isRunning: false } });
    logger.info('Notification service stopped');
    res.json({ status: 'stopped', message: 'Notification service stopped' });
  } catch (err) {
    next(err);
  }
});

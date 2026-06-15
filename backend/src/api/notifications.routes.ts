import { Router } from 'express';
import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { logger } from '../utils/logger.js';

export const notificationsRouter = Router();

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'SENT', 'FAILED']).optional(),
  includeDeleted: z.coerce.boolean().default(false),
});

// GET /api/notifications — list all notification records
notificationsRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, status, includeDeleted } = paginationSchema.parse(req.query);
    const skip = (page - 1) * limit;

    const where = {
      ...(status ? { status } : {}),
      ...(!includeDeleted ? { deletedAt: null } : {}),
    };

    const [records, total] = await Promise.all([
      prisma.notificationRecord.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.notificationRecord.count({ where }),
    ]);

    res.json({
      data: records,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/track — manually add a GitHub issue for tracking
// Use this when an issue was labeled before the service started or outside the
// notify window and no NotificationRecord was created automatically.
const trackSchema = z.object({
  issueNumber: z.number().int().positive(),
});

notificationsRouter.post('/track', async (req, res, next) => {
  try {
    const { issueNumber } = trackSchema.parse(req.body);

    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });
    if (!config) {
      res.status(500).json({ error: 'Config not found' });
      return;
    }

    const parts = config.watchedRepo.split('/');
    if (parts.length !== 2) {
      res.status(400).json({ error: 'watchedRepo is not configured (expected owner/repo)' });
      return;
    }
    const [owner, repo] = parts as [string, string];

    const existing = await prisma.notificationRecord.findUnique({
      where: { githubIssueNumber: issueNumber },
    });

    if (existing && !existing.deletedAt) {
      res.status(409).json({ error: `Issue #${issueNumber} is already being tracked` });
      return;
    }

    const octokit = new Octokit({ auth: config.githubToken ?? undefined });

    let ghIssue: {
      title: string;
      body?: string | null;
      html_url: string;
      labels: Array<{ name?: string | null }>;
    };

    try {
      const ghRes = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: issueNumber,
      });
      ghIssue = ghRes.data as typeof ghIssue;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        res.status(404).json({ error: `Issue #${issueNumber} not found in ${config.watchedRepo}` });
        return;
      }
      throw err;
    }

    const matchedLabel =
      ghIssue.labels.find(
        (l) => (l.name ?? '').toLowerCase() === config.watchedLabel.toLowerCase()
      )?.name ?? config.watchedLabel;

    let record;
    if (existing && existing.deletedAt) {
      record = await prisma.notificationRecord.update({
        where: { id: existing.id },
        data: {
          title: ghIssue.title,
          body: ghIssue.body ?? '',
          url: ghIssue.html_url,
          matchedLabel,
          status: 'PENDING',
          deletedAt: null,
          hasPendingUpdate: false,
          attempts: 0,
          lastAttemptAt: null,
          notifiedAt: null,
        },
      });
      logger.info({ issueNumber, id: record.id }, 'Soft-deleted record restored for manual tracking');
    } else {
      record = await prisma.notificationRecord.create({
        data: {
          githubIssueNumber: issueNumber,
          title: ghIssue.title,
          body: ghIssue.body ?? '',
          url: ghIssue.html_url,
          repoFullName: config.watchedRepo,
          matchedLabel,
          status: 'PENDING',
        },
      });
      logger.info({ issueNumber, id: record.id }, 'Issue manually added for tracking');
    }

    res.status(201).json({ data: record, message: `Issue #${issueNumber} is now being tracked` });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/:id — get single record
notificationsRouter.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.notificationRecord.findUnique({
      where: { id: req.params['id'] },
    });

    if (!record) {
      res.status(404).json({ error: 'Notification record not found' });
      return;
    }

    res.json({ data: record });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/:id — soft delete (sets deletedAt)
notificationsRouter.delete('/:id', async (req, res, next) => {
  try {
    const record = await prisma.notificationRecord.findUnique({
      where: { id: req.params['id'] },
    });

    if (!record) {
      res.status(404).json({ error: 'Notification record not found' });
      return;
    }

    if (record.deletedAt) {
      res.status(409).json({ error: 'Record is already soft-deleted' });
      return;
    }

    const updated = await prisma.notificationRecord.update({
      where: { id: req.params['id'] },
      data: { deletedAt: new Date() },
    });

    logger.info({ id: record.id, issueNumber: record.githubIssueNumber }, 'Soft deleted notification record');
    res.json({ data: updated, message: 'Record soft-deleted' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/:id/hard — permanent delete
notificationsRouter.delete('/:id/hard', async (req, res, next) => {
  try {
    const record = await prisma.notificationRecord.findUnique({
      where: { id: req.params['id'] },
    });

    if (!record) {
      res.status(404).json({ error: 'Notification record not found' });
      return;
    }

    await prisma.notificationRecord.delete({ where: { id: req.params['id'] } });

    logger.info({ id: record.id, issueNumber: record.githubIssueNumber }, 'Hard deleted notification record');
    res.json({ message: 'Record permanently deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/:id/trigger-update — manually queue an update email
// Use when a title/body change happened but the poller missed it (e.g. poll failures).
// Also re-fetches current title+body from GitHub so the email shows the latest content.
notificationsRouter.post('/:id/trigger-update', async (req, res, next) => {
  try {
    const record = await prisma.notificationRecord.findUnique({
      where: { id: req.params['id'] },
    });

    if (!record) {
      res.status(404).json({ error: 'Notification record not found' });
      return;
    }

    if (record.deletedAt) {
      res.status(409).json({ error: 'Record is soft-deleted; restore it first' });
      return;
    }

    if (record.status !== 'SENT') {
      res.status(409).json({ error: 'Initial email not yet sent; update email will follow automatically once it is' });
      return;
    }

    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });
    const parts = (config?.watchedRepo ?? '').split('/');

    let freshTitle = record.title;
    let freshBody = record.body;

    if (parts.length === 2) {
      try {
        const octokit = new Octokit({ auth: config?.githubToken ?? undefined });
        const ghRes = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
          owner: parts[0] as string,
          repo: parts[1] as string,
          issue_number: record.githubIssueNumber,
        });
        freshTitle = (ghRes.data as { title: string }).title;
        freshBody = (ghRes.data as { body?: string | null }).body ?? '';
      } catch {
        // Non-fatal: fall back to stored title/body
      }
    }

    const updated = await prisma.notificationRecord.update({
      where: { id: req.params['id'] },
      data: { title: freshTitle, body: freshBody, hasPendingUpdate: true },
    });

    logger.info({ id: record.id, issueNumber: record.githubIssueNumber }, 'Update manually triggered');
    res.json({ data: updated, message: 'Update email queued; will send within 20s' });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/:id/restore — restore a soft-deleted record
notificationsRouter.post('/:id/restore', async (req, res, next) => {
  try {
    const record = await prisma.notificationRecord.findUnique({
      where: { id: req.params['id'] },
    });

    if (!record) {
      res.status(404).json({ error: 'Notification record not found' });
      return;
    }

    if (!record.deletedAt) {
      res.status(409).json({ error: 'Record is not soft-deleted' });
      return;
    }

    const restored = await prisma.notificationRecord.update({
      where: { id: req.params['id'] },
      data: { deletedAt: null },
    });

    logger.info({ id: record.id, issueNumber: record.githubIssueNumber }, 'Restored notification record');
    res.json({ data: restored, message: 'Record restored' });
  } catch (err) {
    next(err);
  }
});

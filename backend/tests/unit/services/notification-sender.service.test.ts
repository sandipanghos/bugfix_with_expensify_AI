import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, REAL_ISSUES, makeNotificationRecord } from '../../fixtures/github-events.js';

// --- Prisma mock ---
const mockPrisma = vi.hoisted(() => ({
  config: {
    findUnique: vi.fn(),
  },
  notificationRecord: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  proposalRecord: {
    findFirst: vi.fn(),
  },
}));

vi.mock('../../../src/db/client.js', () => ({ prisma: mockPrisma }));

// --- Email service mock ---
const mockSendIssueNotification = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/services/email.service.js', () => ({
  sendIssueNotification: mockSendIssueNotification,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NotificationSenderService } from '../../../src/services/notification-sender.service.js';

const RUNNING_CONFIG = { ...DEFAULT_CONFIG, isRunning: true, notificationEmail: 'sandghos1987@gmail.com' };

describe('NotificationSenderService.send()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.config.findUnique.mockResolvedValue(RUNNING_CONFIG);
    mockPrisma.notificationRecord.findMany.mockResolvedValue([]);
    mockPrisma.notificationRecord.update.mockResolvedValue({});
    // Default: a proposal comment exists, so update notifications are allowed to go out.
    mockPrisma.proposalRecord.findFirst.mockResolvedValue({ id: 'proposal-1' });
  });

  // ─── Early-return guards ──────────────────────────────────────────────────

  it('returns early when config row does not exist', async () => {
    mockPrisma.config.findUnique.mockResolvedValue(null);
    await NotificationSenderService.send();
    expect(mockSendIssueNotification).not.toHaveBeenCalled();
  });

  it('returns early when isRunning is false', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({ ...RUNNING_CONFIG, isRunning: false });
    await NotificationSenderService.send();
    expect(mockSendIssueNotification).not.toHaveBeenCalled();
  });

  it('returns early when notificationEmail is empty', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({ ...RUNNING_CONFIG, notificationEmail: '' });
    await NotificationSenderService.send();
    expect(mockSendIssueNotification).not.toHaveBeenCalled();
  });

  it('does nothing when there are no PENDING or update records', async () => {
    mockPrisma.notificationRecord.findMany.mockResolvedValue([]);
    await NotificationSenderService.send();
    expect(mockSendIssueNotification).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecord.update).not.toHaveBeenCalled();
  });

  // ─── Pass 1 — initial email (PENDING → SENT) ─────────────────────────────

  it('sends initial email for a PENDING record and marks it SENT', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[0]);
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'PENDING') return Promise.resolve([record]);
      return Promise.resolve([]);
    });

    await NotificationSenderService.send();

    expect(mockSendIssueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        to: RUNNING_CONFIG.notificationEmail,
        issueNumber: record.githubIssueNumber,
        issueTitle: record.title,
        issueUrl: record.url,
        isUpdate: false,
      })
    );

    expect(mockPrisma.notificationRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: record.id },
        data: expect.objectContaining({ status: 'SENT' }),
      })
    );
  });

  it('sends emails for all PENDING records in order', async () => {
    const records = [
      makeNotificationRecord(REAL_ISSUES[0]),
      makeNotificationRecord(REAL_ISSUES[1]),
      makeNotificationRecord(REAL_ISSUES[2]),
    ];
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'PENDING') return Promise.resolve(records);
      return Promise.resolve([]);
    });

    await NotificationSenderService.send();

    expect(mockSendIssueNotification).toHaveBeenCalledTimes(3);
    expect(mockPrisma.notificationRecord.update).toHaveBeenCalledTimes(3);
  });

  it('increments attempts on failed email and keeps record PENDING', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[0], { attempts: 2 });
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'PENDING') return Promise.resolve([record]);
      return Promise.resolve([]);
    });

    mockSendIssueNotification.mockRejectedValueOnce(new Error('SMTP connection refused'));

    await NotificationSenderService.send();

    expect(mockPrisma.notificationRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: record.id },
        data: expect.objectContaining({ attempts: { increment: 1 } }),
      })
    );

    // Should NOT have status: SENT
    const updateArgs = mockPrisma.notificationRecord.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBeUndefined();
  });

  it('processes subsequent records even if one fails', async () => {
    const records = [
      makeNotificationRecord(REAL_ISSUES[0]),
      makeNotificationRecord(REAL_ISSUES[1]),
    ];
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'PENDING') return Promise.resolve(records);
      return Promise.resolve([]);
    });

    // First email fails, second succeeds
    mockSendIssueNotification
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(undefined);

    await NotificationSenderService.send();

    expect(mockSendIssueNotification).toHaveBeenCalledTimes(2);
    expect(mockPrisma.notificationRecord.update).toHaveBeenCalledTimes(2);
  });

  // ─── Pass 2 — update email (hasPendingUpdate) ────────────────────────────

  it('sends update email for SENT record with hasPendingUpdate=true', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[0], {
      status: 'SENT',
      hasPendingUpdate: true,
      updateEmailCount: 0,
    });
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'SENT' && where.hasPendingUpdate === true) return Promise.resolve([record]);
      return Promise.resolve([]);
    });

    await NotificationSenderService.send();

    expect(mockSendIssueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        isUpdate: true,
        updateCount: 1,
        issueNumber: record.githubIssueNumber,
      })
    );
  });

  it('sets hasPendingUpdate=false after successful update email', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[0], {
      status: 'SENT',
      hasPendingUpdate: true,
      updateEmailCount: 1,
    });
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'SENT' && where.hasPendingUpdate === true) return Promise.resolve([record]);
      return Promise.resolve([]);
    });

    await NotificationSenderService.send();

    expect(mockPrisma.notificationRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: record.id },
        data: expect.objectContaining({
          hasPendingUpdate: false,
          updateEmailCount: { increment: 1 },
        }),
      })
    );
  });

  it('keeps hasPendingUpdate=true when update email fails (retry next cycle)', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[0], {
      status: 'SENT',
      hasPendingUpdate: true,
    });
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'SENT' && where.hasPendingUpdate === true) return Promise.resolve([record]);
      return Promise.resolve([]);
    });

    mockSendIssueNotification.mockRejectedValueOnce(new Error('SMTP timeout'));

    await NotificationSenderService.send();

    // No update call that sets hasPendingUpdate=false
    const falseUpdate = mockPrisma.notificationRecord.update.mock.calls.find(
      (c) => c[0].data.hasPendingUpdate === false
    );
    expect(falseUpdate).toBeUndefined();
  });

  it('does NOT send an update email when the issue has no proposal comment', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[0], {
      status: 'SENT',
      hasPendingUpdate: true,
      updateEmailCount: 0,
    });
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'SENT' && where.hasPendingUpdate === true) return Promise.resolve([record]);
      return Promise.resolve([]);
    });
    // No proposal comment posted for this issue.
    mockPrisma.proposalRecord.findFirst.mockResolvedValue(null);

    await NotificationSenderService.send();

    expect(mockSendIssueNotification).not.toHaveBeenCalled();
    // The pending-update flag is cleared so we don't re-check it every cycle.
    expect(mockPrisma.notificationRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: record.id },
        data: { hasPendingUpdate: false },
      })
    );
  });

  it('uses correct updateCount (updateEmailCount + 1) for update subject', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[1], {
      status: 'SENT',
      hasPendingUpdate: true,
      updateEmailCount: 3,
    });
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'SENT' && where.hasPendingUpdate === true) return Promise.resolve([record]);
      return Promise.resolve([]);
    });

    await NotificationSenderService.send();

    expect(mockSendIssueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ updateCount: 4 })
    );
  });

  // ─── Soft-deleted records excluded ───────────────────────────────────────

  it('queries PENDING records with deletedAt: null filter', async () => {
    await NotificationSenderService.send();

    expect(mockPrisma.notificationRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      })
    );
  });

  it('queries update records with deletedAt: null filter', async () => {
    await NotificationSenderService.send();

    const updateQueryCall = mockPrisma.notificationRecord.findMany.mock.calls.find(
      (c) => c[0].where.status === 'SENT'
    );
    expect(updateQueryCall?.[0].where.deletedAt).toBeNull();
  });

  // ─── notifiedAt timestamp ─────────────────────────────────────────────────

  it('sets notifiedAt timestamp on successful initial send', async () => {
    const record = makeNotificationRecord(REAL_ISSUES[0]);
    mockPrisma.notificationRecord.findMany.mockImplementation(({ where }) => {
      if (where.status === 'PENDING') return Promise.resolve([record]);
      return Promise.resolve([]);
    });

    await NotificationSenderService.send();

    expect(mockPrisma.notificationRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notifiedAt: expect.any(Date) }),
      })
    );
  });
});

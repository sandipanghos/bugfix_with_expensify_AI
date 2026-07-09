import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CONFIG, makeNotificationRecord, REAL_ISSUES } from '../../fixtures/github-events.js';

// --- Prisma mock (hoisted so it's available in vi.mock factory) ---
const mockPrisma = vi.hoisted(() => ({
  config: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  notificationRecord: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../src/db/client.js', () => ({ prisma: mockPrisma }));

// --- Octokit mock ---
const mockRequest = vi.hoisted(() => vi.fn());

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({ request: mockRequest })),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { IssuePollerService } from '../../../src/services/issue-poller.service.js';

const TODAY = new Date().toISOString().slice(0, 10);
// A token is required — fullScan returns early without one.
const RUNNING_CONFIG = { ...DEFAULT_CONFIG, githubToken: 'ghp_test', dailyResetDate: TODAY };

// Build a GitHub Issues REST API issue payload (the shape fullScan consumes).
function makeIssue(overrides: Record<string, unknown> = {}) {
  const nowIso = new Date().toISOString();
  return {
    number: 50001,
    title: 'A brand new issue opened today',
    body: 'body text',
    html_url: 'https://github.com/Expensify/App/issues/50001',
    created_at: nowIso,
    updated_at: nowIso,
    comments: 0,
    state: 'open',
    labels: [{ name: 'Help Wanted' }],
    ...overrides,
  };
}

function issuesResponse(issues: ReturnType<typeof makeIssue>[]) {
  return { status: 200, headers: {}, data: issues };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('IssuePollerService.fullScan()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.config.findUnique.mockResolvedValue({ ...RUNNING_CONFIG });
    mockPrisma.config.update.mockResolvedValue({ ...RUNNING_CONFIG });
    mockPrisma.notificationRecord.findMany.mockResolvedValue([]);
    mockPrisma.notificationRecord.createMany.mockResolvedValue({ count: 1 });
    mockPrisma.notificationRecord.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.notificationRecord.update.mockResolvedValue({});
    mockRequest.mockResolvedValue(issuesResponse([]));
  });

  // ─── Early-return guards ──────────────────────────────────────────────────

  it('returns false and does not call GitHub when config is missing', async () => {
    mockPrisma.config.findUnique.mockResolvedValue(null);
    expect(await IssuePollerService.fullScan()).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('returns false when isRunning is false', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({ ...RUNNING_CONFIG, isRunning: false });
    expect(await IssuePollerService.fullScan()).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('returns false when no githubToken is configured', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({ ...RUNNING_CONFIG, githubToken: null });
    expect(await IssuePollerService.fullScan()).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('returns false for an invalid watchedRepo format', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({ ...RUNNING_CONFIG, watchedRepo: 'not-a-repo' });
    expect(await IssuePollerService.fullScan()).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  // ─── Request shape ────────────────────────────────────────────────────────

  it('fetches open labeled issues sorted by creation date (newest first)', async () => {
    await IssuePollerService.fullScan();
    expect(mockRequest).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/issues',
      expect.objectContaining({
        owner: 'Expensify',
        repo: 'App',
        labels: 'Help Wanted',
        state: 'open',
        sort: 'created',
        direction: 'desc',
      })
    );
  });

  // ─── Daily reset ──────────────────────────────────────────────────────────

  it('resets dailySelectedCount when dailyResetDate is a past date', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({
      ...RUNNING_CONFIG,
      dailySelectedCount: 3,
      dailyResetDate: '2020-01-01',
    });

    await IssuePollerService.fullScan();

    const resetCall = mockPrisma.config.update.mock.calls.find(
      (c) => c[0].data.dailySelectedCount === 0 && c[0].data.dailyResetDate === TODAY
    );
    expect(resetCall).toBeDefined();
  });

  // ─── New issue selection ──────────────────────────────────────────────────

  it('creates a PENDING NotificationRecord for a new issue created today', async () => {
    const issue = makeIssue();
    mockRequest.mockResolvedValue(issuesResponse([issue]));

    const result = await IssuePollerService.fullScan();

    expect(mockPrisma.notificationRecord.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            githubIssueNumber: issue.number,
            title: issue.title,
            url: issue.html_url,
            status: 'PENDING',
          }),
        ]),
      })
    );
    expect(result).toBe(true);
  });

  it('increments dailySelectedCount after creating a record', async () => {
    mockRequest.mockResolvedValue(issuesResponse([makeIssue()]));

    await IssuePollerService.fullScan();

    const incrementCall = mockPrisma.config.update.mock.calls.find(
      (c) => typeof c[0].data.dailySelectedCount === 'number'
    );
    expect(incrementCall?.[0].data.dailySelectedCount).toBe(DEFAULT_CONFIG.dailySelectedCount + 1);
  });

  it('does NOT create a record for an issue not created today', async () => {
    mockRequest.mockResolvedValue(issuesResponse([makeIssue({ created_at: daysAgoIso(3) })]));

    await IssuePollerService.fullScan();

    expect(mockPrisma.notificationRecord.createMany).not.toHaveBeenCalled();
  });

  it('does NOT create a record when the daily limit is already reached', async () => {
    mockPrisma.config.findUnique.mockResolvedValue({
      ...RUNNING_CONFIG,
      dailySelectedCount: 4,
      issueLimit: 4,
    });
    mockRequest.mockResolvedValue(issuesResponse([makeIssue()]));

    await IssuePollerService.fullScan();

    expect(mockPrisma.notificationRecord.createMany).not.toHaveBeenCalled();
  });

  // ─── Closure / label removal ──────────────────────────────────────────────

  it('soft-deletes a tracked record that is no longer in the open results', async () => {
    const tracked = makeNotificationRecord(REAL_ISSUES[0], { status: 'SENT' });
    mockPrisma.notificationRecord.findMany.mockResolvedValue([tracked]);
    mockRequest.mockResolvedValue(issuesResponse([])); // issue gone from snapshot

    await IssuePollerService.fullScan();

    expect(mockPrisma.notificationRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [tracked.id] } },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      })
    );
  });

  // ─── Update detection ─────────────────────────────────────────────────────

  it('sets hasPendingUpdate for a changed SENT issue', async () => {
    const tracked = makeNotificationRecord(REAL_ISSUES[0], {
      status: 'SENT',
      body: 'original body',
      githubUpdatedAt: '2026-01-01T00:00:00Z',
      commentCount: 0,
    });
    mockPrisma.notificationRecord.findMany.mockResolvedValue([tracked]);
    mockRequest.mockResolvedValue(
      issuesResponse([
        makeIssue({
          number: tracked.githubIssueNumber,
          title: 'A different title now',
          body: 'original body',
          updated_at: '2026-07-05T12:00:00Z',
          created_at: daysAgoIso(1),
        }),
      ])
    );

    const result = await IssuePollerService.fullScan();

    const flagUpdate = mockPrisma.notificationRecord.update.mock.calls.find(
      (c) => c[0].where.id === tracked.id && c[0].data.hasPendingUpdate === true
    );
    expect(flagUpdate).toBeDefined();
    expect(result).toBe(true);
  });

  it('does NOT set hasPendingUpdate for a changed PENDING issue (never emailed yet)', async () => {
    const tracked = makeNotificationRecord(REAL_ISSUES[0], {
      status: 'PENDING',
      body: 'original body',
      githubUpdatedAt: '2026-01-01T00:00:00Z',
      commentCount: 0,
    });
    mockPrisma.notificationRecord.findMany.mockResolvedValue([tracked]);
    mockRequest.mockResolvedValue(
      issuesResponse([
        makeIssue({
          number: tracked.githubIssueNumber,
          title: 'A different title now',
          body: 'original body',
          updated_at: '2026-07-05T12:00:00Z',
          created_at: daysAgoIso(1),
        }),
      ])
    );

    await IssuePollerService.fullScan();

    const flagUpdate = mockPrisma.notificationRecord.update.mock.calls.find(
      (c) => c[0].data.hasPendingUpdate === true
    );
    expect(flagUpdate).toBeUndefined();
  });
});

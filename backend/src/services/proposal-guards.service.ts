import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';

export class GuardViolationError extends Error {
  details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'GuardViolationError';
    this.details = details;
  }
}

export interface IssueComment {
  body?: string | null;
  user?: { login?: string | null } | null;
  html_url: string;
}

// Guard: only one proposal per contributor per issue.
// Checks our own ProposalRecord table first (authoritative for proposals this
// API posted), then defensively scans live GitHub comments in case the same
// contributor already posted a proposal manually outside this system.
export async function assertNoExistingProposal(
  comments: IssueComment[],
  issueNumber: number,
  repoFullName: string,
  contributorUsername: string
): Promise<void> {
  const existing = await prisma.proposalRecord.findUnique({
    where: {
      githubIssueNumber_repoFullName_contributorUsername: {
        githubIssueNumber: issueNumber,
        repoFullName,
        contributorUsername,
      },
    },
  });
  if (existing) {
    throw new GuardViolationError(
      `@${contributorUsername} already submitted a proposal for ${repoFullName}#${issueNumber}`,
      { commentUrl: existing.commentUrl, postedAt: existing.createdAt }
    );
  }

  const ownPriorComment = comments.find(
    (c) =>
      (c.user?.login ?? '').toLowerCase() === contributorUsername.toLowerCase() &&
      /##\s*proposal/i.test(c.body ?? '')
  );
  if (ownPriorComment) {
    throw new GuardViolationError(
      `@${contributorUsername} already has a proposal comment on ${repoFullName}#${issueNumber}`,
      { commentUrl: ownPriorComment.html_url }
    );
  }
}

// Guard: the new proposal must differ meaningfully from existing proposals
// already posted on the issue (by anyone), based on root-cause text overlap.
export async function assertProposalIsDifferent(
  comments: IssueComment[],
  newRootCause: string
): Promise<void> {
  const existingRootCauses = comments
    .map((c) => extractRootCause(c.body ?? ''))
    .filter((rc): rc is string => !!rc);

  for (const existingRootCause of existingRootCauses) {
    const similarity = jaccardSimilarity(newRootCause, existingRootCause);
    if (similarity >= 0.6) {
      throw new GuardViolationError(
        "Your proposal's root cause is too similar to an existing proposal already posted on this issue",
        { similarity, existingRootCause }
      );
    }
  }
}

// Guard: contributor must not already have an open issue/PR assigned to them
// (anywhere on GitHub) waiting on their action before taking on a new one.
export async function assertNoAssignedWorkPending(
  octokit: Octokit,
  contributorUsername: string
): Promise<void> {
  const res = await octokit.request('GET /search/issues', {
    q: `is:issue assignee:${contributorUsername} state:open`,
    per_page: 5,
  });

  if (res.data.total_count > 0) {
    throw new GuardViolationError(
      `@${contributorUsername} already has ${res.data.total_count} open assigned issue(s)/PR(s) — finish those before submitting a new proposal`,
      {
        items: res.data.items.map((i) => ({
          number: i.number,
          title: i.title,
          url: i.html_url,
        })),
      }
    );
  }
}

export async function listIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<IssueComment[]> {
  const res = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return res.data;
}

function extractRootCause(commentBody: string): string | null {
  const match = commentBody.match(
    /###\s*What is the root cause[^\n]*\n+([\s\S]*?)(\n###|\n##|$)/i
  );
  return match?.[1]?.trim() ?? null;
}

function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

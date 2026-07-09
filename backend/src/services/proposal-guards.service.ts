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

// A proposal counts as a duplicate only when it is essentially identical to one
// already posted on the issue — root cause, proposed change, AND alternative
// solutions must ALL overlap at or above this threshold. Anything less means at
// least one section is meaningfully different, so the proposal is treated as new.
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.98;

export interface ProposalParts {
  rootCause: string;
  proposedChange: string;
  alternatives: string;
}

// Guard: the new proposal must not be a near-duplicate of a proposal already
// posted on the issue (by anyone). It is rejected only when its root cause,
// proposed change, and alternative solutions are ALL ≥98% similar to the
// corresponding sections of a single existing proposal. If any one section
// differs meaningfully, the proposal is considered distinct and allowed.
// Kept async for a uniform Promise<void> guard interface even though the body is sync.
// eslint-disable-next-line @typescript-eslint/require-await
export async function assertProposalIsDifferent(
  comments: IssueComment[],
  newProposal: ProposalParts
): Promise<void> {
  for (const comment of comments) {
    const existing = extractProposalParts(comment.body ?? '');
    // Only compare against comments that actually contain a proposal.
    if (!existing.rootCause) continue;

    const rootCauseSim = sectionSimilarity(newProposal.rootCause, existing.rootCause);
    const proposedChangeSim = sectionSimilarity(newProposal.proposedChange, existing.proposedChange);
    const alternativesSim = sectionSimilarity(newProposal.alternatives, existing.alternatives);

    if (
      rootCauseSim >= DUPLICATE_SIMILARITY_THRESHOLD &&
      proposedChangeSim >= DUPLICATE_SIMILARITY_THRESHOLD &&
      alternativesSim >= DUPLICATE_SIMILARITY_THRESHOLD
    ) {
      throw new GuardViolationError(
        'Your proposal is a near-duplicate of an existing proposal on this issue — its root cause, proposed change, and alternative solutions are all ≥98% identical',
        { rootCauseSim, proposedChangeSim, alternativesSim }
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

function extractSection(commentBody: string, headerRegex: RegExp): string {
  const match = commentBody.match(headerRegex);
  return (match?.[1] ?? '').trim();
}

// Pulls the three proposal sections out of a GitHub comment body, matching the
// section headers of the Expensify proposal template that the generator emits.
function extractProposalParts(commentBody: string): ProposalParts {
  const rootCause = extractSection(
    commentBody,
    /###\s*What is the root cause[^?\n]*\?\s*\n([\s\S]*?)(?=\n### |\n\*\*Reminder:|<!--|$)/i
  );
  const proposedChange = extractSection(
    commentBody,
    /###\s*What changes[^?\n]*\?\s*\n(?:<!--[^\n]*-->\s*\n)?([\s\S]*?)(?=\n### |\n\*\*Reminder:|<!--|$)/i
  );
  const alternatives = extractSection(
    commentBody,
    /###\s*What alternative[^?\n]*\?\s*(?:\(Optional\))?\s*\n([\s\S]*?)(?=\n### |\n\*\*Reminder:|<!--|$)/i
  );
  return { rootCause, proposedChange, alternatives };
}

// Similarity of two proposal sections. Two absent sections count as identical
// (both empty → 1); one present and one absent count as completely different (0).
function sectionSimilarity(a: string, b: string): number {
  const aEmpty = a.trim() === '';
  const bEmpty = b.trim() === '';
  if (aEmpty && bEmpty) return 1;
  if (aEmpty || bEmpty) return 0;
  return jaccardSimilarity(a, b);
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

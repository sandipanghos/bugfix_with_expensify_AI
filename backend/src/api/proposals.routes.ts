import { Router } from 'express';
import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import { prisma } from '../db/client.js';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { generateProposal } from '../services/proposal-generator.service.js';
import {
  assertNoExistingProposal,
  assertProposalIsDifferent,
  assertNoAssignedWorkPending,
  listIssueComments,
  GuardViolationError,
} from '../services/proposal-guards.service.js';

export const proposalsRouter = Router();

const GITHUB_ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/;

const createProposalSchema = z.object({
  issueUrl: z
    .string()
    .url()
    .regex(GITHUB_ISSUE_URL_RE, 'Must be a GitHub issue URL: https://github.com/owner/repo/issues/123'),
  contributorUsername: z.string().min(1),
});

// POST /api/proposals — generate (via LLM) and post a contributor proposal to a GitHub issue.
// The full proposal markdown is produced by generateProposal using ROOT_CAUSE_PROMPT_TEMPLATE.md
// and posted verbatim — no client-side assembly needed.
proposalsRouter.post('/', async (req, res, next) => {
  try {
    if (!env.ANTHROPIC_API_KEY) {
      res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
      return;
    }

    const { issueUrl, contributorUsername } = createProposalSchema.parse(req.body);

    const urlMatch = GITHUB_ISSUE_URL_RE.exec(issueUrl);
    // Zod already validated the pattern; this is a defensive guard for TypeScript.
    if (!urlMatch || !urlMatch[1] || !urlMatch[2] || !urlMatch[3]) {
      res.status(400).json({ error: 'Could not parse GitHub issue URL' });
      return;
    }
    const owner = urlMatch[1];
    const repo = urlMatch[2];
    const issueNumber = parseInt(urlMatch[3], 10);
    const repoFullName = `${owner}/${repo}`;

    const config = await prisma.config.findUnique({ where: { id: 'singleton' } });
    const octokit = new Octokit({ auth: config?.githubToken ?? env.GITHUB_TOKEN });

    let issue: { title: string; body?: string | null; state: string };
    try {
      const ghRes = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
        owner,
        repo,
        issue_number: issueNumber,
      });
      issue = ghRes.data;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        res.status(404).json({ error: `Issue #${issueNumber} not found in ${repoFullName}` });
        return;
      }
      throw err;
    }

    if (issue.state !== 'open') {
      res.status(422).json({ error: `Issue #${issueNumber} is closed — proposals can only be posted on open issues` });
      return;
    }

    const comments = await listIssueComments(octokit, owner, repo, issueNumber);

    // Cheap guards first — avoid wasting an LLM call if the request is already disqualified.
    try {
      await assertNoExistingProposal(comments, issueNumber, repoFullName, contributorUsername);
      await assertNoAssignedWorkPending(octokit, contributorUsername);
    } catch (err) {
      if (err instanceof GuardViolationError) {
        res.status(409).json({ error: err.message, details: err.details });
        return;
      }
      throw err;
    }

    const generated = await generateProposal({
      repoFullName,
      issueNumber,
      issueTitle: issue.title,
      issueBody: issue.body ?? '',
      issueComments: comments.map((c) => c.body ?? '').filter(Boolean),
      issueUrl,
      octokit,
    });

    // This guard compares the generated proposal against existing ones, so it runs after generation.
    try {
      await assertProposalIsDifferent(comments, generated);
    } catch (err) {
      if (err instanceof GuardViolationError) {
        res.status(409).json({ error: err.message, details: err.details });
        return;
      }
      throw err;
    }

    const { commentBody } = generated;
    let postRes;
    try {
      postRes = await octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { owner, repo, issue_number: issueNumber, body: commentBody }
      );
    } catch (err: unknown) {
      // 403 here means the token authenticated but isn't allowed to comment on this repo.
      // Most common cause: a fine-grained PAT (can't write to repos you don't own) or a
      // classic PAT missing the `public_repo`/`repo` scope.
      if ((err as { status?: number }).status === 403) {
        res.status(403).json({
          error: `GitHub token cannot post comments to ${repoFullName}. Use a classic PAT with the \`public_repo\` scope (a fine-grained PAT cannot comment on repos you don't own).`,
        });
        return;
      }
      throw err;
    }

    const record = await prisma.proposalRecord.create({
      data: {
        githubIssueNumber: issueNumber,
        repoFullName,
        contributorUsername,
        rootCause: generated.rootCause,
        proposedChange: generated.proposedChange,
        alternatives: generated.alternatives,
        commentBody,
        commentUrl: postRes.data.html_url,
        commentId: BigInt(postRes.data.id),
      },
    });

    logger.info(
      { issueNumber, repoFullName, contributorUsername, commentUrl: record.commentUrl },
      'Proposal posted'
    );
    res.status(201).json({ data: record, message: `Proposal posted to ${repoFullName}#${issueNumber}` });
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  contributorUsername: z.string().optional(),
  githubIssueNumber: z.coerce.number().int().positive().optional(),
});

// GET /api/proposals — list posted proposals, optionally filtered by contributor or issue.
proposalsRouter.get('/', async (req, res, next) => {
  try {
    const { page, limit, contributorUsername, githubIssueNumber } = listQuerySchema.parse(req.query);
    const skip = (page - 1) * limit;
    const where = {
      ...(contributorUsername ? { contributorUsername } : {}),
      ...(githubIssueNumber ? { githubIssueNumber } : {}),
    };

    const [data, total] = await Promise.all([
      prisma.proposalRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.proposalRecord.count({ where }),
    ]);

    res.json({ data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
});

// GET /api/proposals/:id — single proposal record by CUID.
proposalsRouter.get('/:id', async (req, res, next) => {
  try {
    const record = await prisma.proposalRecord.findUnique({ where: { id: req.params.id } });
    if (!record) {
      res.status(404).json({ error: 'Proposal record not found' });
      return;
    }
    res.json({ data: record });
  } catch (err) {
    next(err);
  }
});

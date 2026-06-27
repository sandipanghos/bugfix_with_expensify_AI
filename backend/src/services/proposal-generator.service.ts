import Anthropic from '@anthropic-ai/sdk';
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';

export interface GeneratedProposal {
  rootCause: string;
  proposedChange: string;
  alternatives: string;
  commentBody: string; // full formatted markdown — posted verbatim to GitHub
}

interface ProposalInput {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueComments: string[];
  issueUrl?: string;
  octokit?: Octokit; // when provided, the LLM can read source files from the repo at runtime
}

// Works in both dev (src/services/) and prod (dist/services/) — both are two levels
// below the backend root where ROOT_CAUSE_PROMPT_TEMPLATE.md lives.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATE_PATH = join(__dirname, '../../ROOT_CAUSE_PROMPT_TEMPLATE.md');

function loadTemplate(): string {
  try {
    return readFileSync(TEMPLATE_PATH, 'utf-8');
  } catch {
    throw new Error(`ROOT_CAUSE_PROMPT_TEMPLATE.md not found at ${TEMPLATE_PATH}`);
  }
}

const SYSTEM_PROMPT = `You are a world-class software engineer with 20+ years of experience shipping production code at top technology companies. You specialise in precise root-cause analysis, minimal correct fixes, and clear written communication.

When analysing a GitHub issue:
- Always read actual source code with the provided tools before making any claim about a file, function, or line number. Never guess or invent implementations.
- Identify the single deepest root cause — the line or logic path that is actually wrong — not just a symptom.
- Propose the smallest correct change that fixes the root cause without breaking surrounding behaviour.
- Cite specific file paths, function names, and code snippets you have actually read.
- Write as a principal engineer would: concise, precise, and immediately actionable.
- If the issue is ambiguous, state your assumption explicitly before proceeding.`;

// Maximum tool-call rounds before forcing a final answer.
// Repo tree is injected into the prompt and source dirs are pre-warmed, so most
// proposals finish in a few rounds; 25 gives deep-exploration headroom for complex
// issues while still capping runaway loops.
const MAX_TOOL_ROUNDS = 25;
// Files larger than this are skipped to avoid blowing the context window.
const MAX_FILE_BYTES = 200_000;

// ── Repo file cache ───────────────────────────────────────────────────────────
// Shared across all concurrent proposals so the same file is never fetched twice
// within the TTL window. Files/directory listings are stable for 30 min; search
// results are shorter-lived because new code may be pushed between proposals.
interface RepoCacheEntry { content: string; cachedAt: number }
const repoCache = new Map<string, RepoCacheEntry>();
const FILE_CACHE_TTL_MS   = 30 * 60 * 1000;
const SEARCH_CACHE_TTL_MS =  5 * 60 * 1000;

function cacheGet(key: string, ttl: number): string | undefined {
  const entry = repoCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > ttl) { repoCache.delete(key); return undefined; }
  return entry.content;
}
function cacheSet(key: string, content: string): void {
  repoCache.set(key, { content, cachedAt: Date.now() });
}

// Source-directory names to pre-warm in parallel after the root listing.
const SOURCE_DIRS = new Set(['src', 'app', 'lib', 'core', 'packages', 'backend', 'frontend', 'server', 'client']);

/**
 * Fetches the repo root directory listing (blocking, for prompt injection) and kicks off
 * background pre-warming of first-level source directories (non-blocking).
 * By the time the LLM produces its first tool_use response (~2 s), the background fetches
 * (~300 ms total, parallel) are already in cache — making those tool calls instant.
 * Returns the root listing string to inject into the prompt.
 */
async function prewarmRepoCache(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const rootKey = `${owner}/${repo}:dir:`;
  const cached = cacheGet(rootKey, FILE_CACHE_TTL_MS);
  if (cached !== undefined) return cached; // already warm

  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path: '',
    });
    const items = res.data as Array<{ name: string; type: string; path: string }>;
    if (!Array.isArray(items)) return '';

    const listing = items.map((i) => `${i.type === 'dir' ? '[dir]' : '[file]'} ${i.path}`).join('\n');
    cacheSet(rootKey, listing);

    // Background: fetch first-level source directories in parallel.
    // Completes in ~300 ms — well before the first LLM tool_use response (~2 s).
    const dirsToWarm = items.filter((i) => i.type === 'dir' && SOURCE_DIRS.has(i.name.toLowerCase()));
    void Promise.all(
      dirsToWarm.map(async (dir) => {
        const key = `${owner}/${repo}:dir:${dir.path}`;
        if (cacheGet(key, FILE_CACHE_TTL_MS) !== undefined) return;
        try {
          const r = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner, repo, path: dir.path,
          });
          const dirItems = r.data as Array<{ name: string; type: string; path: string }>;
          if (Array.isArray(dirItems)) {
            cacheSet(key, dirItems.map((i) => `${i.type === 'dir' ? '[dir]' : '[file]'} ${i.path}`).join('\n'));
          }
        } catch { /* non-fatal — LLM falls back to live tool call */ }
      }),
    );

    return listing;
  } catch {
    return ''; // non-fatal — LLM falls back to tool calls with no injected tree
  }
}

const REPO_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_file_contents',
    description:
      'Read the full source code of a file from the GitHub repository. ' +
      'Always call this before quoting or citing specific code — never invent file contents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repo root, e.g. "src/utils/helpers.ts"',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and subdirectories at a path in the repository. ' +
      'The root-level structure is already provided in the prompt — call this only for subdirectories not already listed there.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repo root, e.g. "src/services".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description:
      'Search for files in the repository that contain a given symbol, string, or error message. ' +
      'Returns matching file paths — use get_file_contents to read the actual code.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (function name, error message, variable name, etc.)',
        },
      },
      required: ['query'],
    },
  },
];

async function executeRepoTool(
  name: string,
  input: Record<string, string>,
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<string> {
  if (name === 'get_file_contents') {
    const cacheKey = `${owner}/${repo}:${input.path}`;
    const cached = cacheGet(cacheKey, FILE_CACHE_TTL_MS);
    if (cached !== undefined) {
      logger.debug({ path: input.path }, 'Repo cache hit: get_file_contents');
      return cached;
    }
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path: input.path ?? '',
      });
      const data = res.data as { type?: string; content?: string; encoding?: string; size?: number };
      if (data.type !== 'file') { const r = `Not a file: ${input.path}`; cacheSet(cacheKey, r); return r; }
      if ((data.size ?? 0) > MAX_FILE_BYTES) {
        const r = `File too large to read (${data.size} bytes): ${input.path}`;
        cacheSet(cacheKey, r);
        return r;
      }
      if (data.content && data.encoding === 'base64') {
        const r = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
        cacheSet(cacheKey, r);
        return r;
      }
      return 'Unable to decode file contents';
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        const r = `File not found: ${input.path}`;
        cacheSet(cacheKey, r); // cache 404s so the LLM doesn't retry the same missing path
        return r;
      }
      throw err;
    }
  }

  if (name === 'list_directory') {
    const path = input.path === '/' ? '' : (input.path ?? '');
    const cacheKey = `${owner}/${repo}:dir:${path}`;
    const cached = cacheGet(cacheKey, FILE_CACHE_TTL_MS);
    if (cached !== undefined) {
      logger.debug({ path }, 'Repo cache hit: list_directory');
      return cached;
    }
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
      });
      const items = res.data as Array<{ name: string; type: string; path: string }>;
      if (!Array.isArray(items)) { const r = `Not a directory: ${path || '/'}`; cacheSet(cacheKey, r); return r; }
      const r = items.map((i) => `${i.type === 'dir' ? '[dir]' : '[file]'} ${i.path}`).join('\n');
      cacheSet(cacheKey, r);
      return r;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) {
        const r = `Directory not found: ${path || '/'}`;
        cacheSet(cacheKey, r);
        return r;
      }
      throw err;
    }
  }

  if (name === 'search_code') {
    const cacheKey = `search:${owner}/${repo}:${input.query}`;
    const cached = cacheGet(cacheKey, SEARCH_CACHE_TTL_MS);
    if (cached !== undefined) {
      logger.debug({ query: input.query }, 'Repo cache hit: search_code');
      return cached;
    }
    try {
      const res = await octokit.request('GET /search/code', {
        q: `${input.query} repo:${owner}/${repo}`,
        per_page: 10,
      });
      const items = res.data.items as Array<{ path: string }>;
      const r = items.length === 0 ? 'No matching files found' : items.map((i) => i.path).join('\n');
      cacheSet(cacheKey, r);
      return r;
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 403) {
        return 'GitHub code search rate limit reached — try a different search or read files directly';
      }
      throw err;
    }
  }

  return `Unknown tool: ${name}`;
}

export async function generateProposal(input: ProposalInput): Promise<GeneratedProposal> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const [owner, repo] = input.repoFullName.split('/') as [string, string];
  // Prefer the caller-supplied octokit (already authenticated with config token).
  // Fall back to env.GITHUB_TOKEN so the LLM always has repo read access when the
  // token is configured in .env even if the caller didn't pass an octokit.
  const octokit = input.octokit ?? (env.GITHUB_TOKEN ? new Octokit({ auth: env.GITHUB_TOKEN }) : undefined);
  const tools = octokit ? REPO_TOOLS : [];

  // Pre-fetch root directory listing to inject into the prompt, and kick off
  // background pre-warming of first-level source directories in parallel.
  // This eliminates 1–2 exploratory tool rounds from the LLM loop.
  const repoTree = octokit ? await prewarmRepoCache(octokit, owner, repo) : '';

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: buildPrompt(input, !!octokit, repoTree) },
  ];

  let toolRounds = 0;
  let finalText = '';
  const llmStart = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      ...(tools.length > 0 ? { tools } : {}),
      messages,
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    if (response.stop_reason === 'end_turn') {
      const block = response.content.find((b) => b.type === 'text');
      finalText = block && block.type === 'text' ? block.text : '';
      break;
    }

    if (response.stop_reason === 'tool_use' && octokit && toolRounds < MAX_TOOL_ROUNDS) {
      toolRounds++;
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (block) => {
          if (block.type !== 'tool_use') {
            return { type: 'tool_result' as const, tool_use_id: '', content: '' };
          }
          const toolInput = block.input as Record<string, string>;
          const result = await executeRepoTool(block.name, toolInput, octokit, owner, repo);
          logger.debug(
            {
              tool: block.name,
              arg: toolInput.path ?? toolInput.query,
              issueNumber: input.issueNumber,
            },
            'Repo tool executed',
          );
          return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
        }),
      );

      messages.push({ role: 'user', content: toolResults });
    } else {
      // Tool-round cap hit while the model still wants to call tools. Its current
      // response has only tool_use blocks (no usable text), so grabbing text here
      // would yield an empty proposal. Instead, append the pending assistant turn
      // plus stubbed tool_results, then make ONE final call WITH NO TOOLS to force
      // the model to write its proposal from everything it has already read.
      const block = response.content.find((b) => b.type === 'text');
      const partialText = block && block.type === 'text' ? block.text : '';

      if (response.stop_reason === 'tool_use' && octokit) {
        logger.warn(
          { issueNumber: input.issueNumber, toolRounds },
          'Tool-round cap reached — forcing a final no-tools completion',
        );
        const pendingToolUses = response.content.filter((b) => b.type === 'tool_use');
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [
            ...pendingToolUses.map((b) => ({
              type: 'tool_result' as const,
              tool_use_id: b.type === 'tool_use' ? b.id : '',
              content: 'Tool budget exhausted — no more file reads are available.',
            })),
            {
              type: 'text' as const,
              text: 'You have reached the tool-use limit. Using only the code you have ALREADY read, write the complete proposal now. Output ONLY the content from `## Proposal` through the final Reminder line. Do not request any more tools.',
            },
          ],
        });

        const finalResponse = await anthropic.messages.create({
          model: 'claude-opus-4-8',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages, // no `tools` — model cannot call tools, must answer
        });
        totalInputTokens += finalResponse.usage?.input_tokens ?? 0;
        totalOutputTokens += finalResponse.usage?.output_tokens ?? 0;
        const finalBlock = finalResponse.content.find((b) => b.type === 'text');
        finalText = finalBlock && finalBlock.type === 'text' ? finalBlock.text : partialText;
      } else {
        finalText = partialText;
      }
      break;
    }
  }

  logger.info(
    { issueNumber: input.issueNumber, llmMs: Date.now() - llmStart, totalInputTokens, totalOutputTokens, toolRounds },
    'Proposal LLM call complete',
  );

  try {
    return parseProposal(finalText);
  } catch (err) {
    logger.error(
      { issueNumber: input.issueNumber, rawText: finalText },
      'parseProposal failed — raw LLM response logged',
    );
    throw err;
  }
}

function buildPrompt(input: ProposalInput, hasRepoAccess: boolean, repoTree = ''): string {
  const issueUrl =
    input.issueUrl ?? `https://github.com/${input.repoFullName}/issues/${input.issueNumber}`;

  const commentsBlock = input.issueComments.length
    ? input.issueComments.join('\n---\n')
    : '(no comments yet)';

  const filledTemplate = loadTemplate()
    .replace('- Issue URL: []', `- Issue URL: ${issueUrl}`)
    .replace(
      '- Repo + branch/commit: [repo @ sha]',
      `- Repo + branch/commit: ${input.repoFullName} @ main`,
    )
    .replace(
      '- Affected build/env: [prod / staging / local, version]',
      '- Affected build/env: Production / Staging',
    )
    .replace(
      '- Repro steps as reported: [paste]',
      '- Repro steps as reported: See full issue body below',
    )
    .replace(
      '- Evidence: [video / logs / screenshots / Sentry link]',
      '- Evidence: See issue comments below',
    );

  const treeSection = repoTree
    ? `\n**Repository root structure:**\n\`\`\`\n${repoTree}\n\`\`\`\n` +
      'Use this to navigate directly to relevant files. ' +
      'Do NOT call `list_directory("")` — it is already shown above. ' +
      'Call `list_directory` only for subdirectories not listed here.\n'
    : '';

  const toolNote = hasRepoAccess
    ? '\nYou have tools to read the live repository source: `get_file_contents`, `list_directory`, and `search_code`. ' +
      'Use them to read REAL code before making any claims about specific files, functions, or line numbers. ' +
      'Never invent or guess code — only cite what you have actually read. ' +
      'Identify the 2–3 most relevant files from the structure above and read those directly.\n' +
      treeSection
    : '';

  return `${filledTemplate}${toolNote}
---

## FULL ISSUE DATA (for your analysis)

**Issue #${input.issueNumber}: ${input.issueTitle}**

### Issue Body:
${input.issueBody || '(no description provided)'}

### Existing Comments (oldest first):
${commentsBlock}

---

Output ONLY the content starting from \`## Proposal\` through the **Reminder:** line at the end. Include the \`<!-- DO NOT POST CODE DIFFS -->\` comment verbatim. Do not output anything before \`## Proposal\`.`;
}

// Minimum usable proposal length — anything shorter is effectively empty (e.g. just
// the "## Proposal" heading) and must not be posted.
const MIN_PROPOSAL_BODY_CHARS = 80;

function parseProposal(text: string): GeneratedProposal {
  // Reject empty/near-empty generations outright so we never post a bare heading.
  const stripped = text.replace(/##\s*Proposal/i, '').trim();
  if (stripped.length < MIN_PROPOSAL_BODY_CHARS) {
    throw new Error(
      `LLM produced an empty or too-short proposal (${stripped.length} chars of content) — not posting`,
    );
  }

  // Isolate the ## Proposal block (everything from the heading onwards).
  let proposalStart = text.indexOf('## Proposal');
  // Lenient fallback: if the LLM omitted the heading, treat the whole response as the proposal body.
  if (proposalStart === -1) {
    text = `## Proposal\n\n${text.trim()}`;
    proposalStart = 0;
  }
  const commentBody = text.slice(proposalStart).trim();

  // Root cause section — text between the heading and the next "###".
  const rootCauseMatch = commentBody.match(
    /### What is the root cause[^?\n]*\?\s*\n([\s\S]*?)(?=\n### |\n\*\*Reminder:|<!--|$)/,
  );
  const rootCause = (rootCauseMatch?.[1] ?? '').trim() || commentBody;

  // Proposed changes — text after the <!-- DO NOT POST CODE DIFFS --> comment.
  const proposedChangeMatch = commentBody.match(
    /### What changes[^?\n]*\?\s*\n<!--[^\n]*-->\s*\n([\s\S]*?)(?=\n### |\n\*\*Reminder:|<!--|$)/,
  );
  const proposedChange = (proposedChangeMatch?.[1] ?? '').trim();

  // Alternatives — text between the heading and the **Reminder** / HTML comment.
  const alternativesMatch = commentBody.match(
    /### What alternative[^?\n]*\?\s*(?:\(Optional\))?\s*\n([\s\S]*?)(?=\n\*\*Reminder:|<!--|$)/,
  );
  const alternatives = (alternativesMatch?.[1] ?? '').trim();

  if (!rootCause) {
    throw new Error('Could not parse root cause from LLM response');
  }

  return { rootCause, proposedChange, alternatives, commentBody };
}

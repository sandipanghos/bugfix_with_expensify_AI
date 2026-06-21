import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../utils/env.js';

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

export async function generateProposal(input: ProposalInput): Promise<GeneratedProposal> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: buildPrompt(input) }],
  });

  const block = response.content.find((b) => b.type === 'text');
  return parseProposal(block && block.type === 'text' ? block.text : '');
}

function buildPrompt(input: ProposalInput): string {
  const issueUrl =
    input.issueUrl ?? `https://github.com/${input.repoFullName}/issues/${input.issueNumber}`;

  const commentsBlock = input.issueComments.length
    ? input.issueComments.join('\n---\n')
    : '(no comments yet)';

  // Fill the INPUTS placeholders in the template with real values.
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

  return `${filledTemplate}

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

function parseProposal(text: string): GeneratedProposal {
  // Isolate the ## Proposal block (everything from the heading onwards).
  const proposalStart = text.indexOf('## Proposal');
  if (proposalStart === -1) {
    throw new Error('LLM response does not contain a ## Proposal section');
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

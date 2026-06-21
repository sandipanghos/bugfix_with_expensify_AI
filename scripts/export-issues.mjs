/**
 * Fetches open Bug issues from Expensify/App — both "Help Wanted" and non-"Help Wanted" —
 * and exports them to an Excel file in ~/Downloads with two sheets:
 *   Sheet 1 "Issues"       — one row per issue, full body + proposal columns
 *   Sheet 2 "All Comments" — one row per comment (regular + proposal)
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/export-issues.mjs
 *
 * Without a token you get 60 req/hr. With a token: 5000 req/hr.
 * Set MAX_PER_CATEGORY below to control how many issues per category to fetch.
 */

import { homedir } from 'os';
import { join } from 'path';
import * as XLSX from 'xlsx';

// ── Config ────────────────────────────────────────────────────────────────────
const OWNER = 'Expensify';
const REPO  = 'App';
const MAX_PER_CATEGORY = 50; // max issues to fetch per category (Help Wanted / no Help Wanted)
// ──────────────────────────────────────────────────────────────────────────────

const BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;
const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

// Excel hard limit per cell
const CELL_MAX = 32767;
const cap = str => (typeof str === 'string' && str.length > CELL_MAX ? str.slice(0, CELL_MAX - 3) + '...' : str);

async function ghGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: HEADERS });

    if (res.status === 403 || res.status === 429) {
      // Check for Retry-After or x-ratelimit-reset header
      const retryAfter = res.headers.get('retry-after');
      const resetAt    = res.headers.get('x-ratelimit-reset');
      let waitMs = 61_000; // default: wait 61s
      if (retryAfter) {
        waitMs = (parseInt(retryAfter, 10) + 1) * 1000;
      } else if (resetAt) {
        waitMs = Math.max(0, parseInt(resetAt, 10) * 1000 - Date.now()) + 1000;
      }
      if (attempt < 3) {
        console.warn(`\n  ⏳ Rate limited — waiting ${Math.ceil(waitMs / 1000)}s before retry ${attempt + 1}/3…`);
        await sleep(waitMs);
        continue;
      }
      const text = await res.text();
      throw new Error(`GitHub ${res.status} ${url}\n${text}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${res.status} ${url}\n${text}`);
    }
    return res.json();
  }
}

/** Fetch open Bug issues, paginated. Returns all (up to 200). */
async function fetchAllBugIssues() {
  const issues = [];
  for (let page = 1; page <= 2; page++) {
    const batch = await ghGet('/issues', {
      labels: 'Bug',
      state: 'open',
      per_page: 100,
      page,
      sort: 'created',
      direction: 'desc',
    });
    // GitHub issues endpoint also returns PRs — exclude them
    issues.push(...batch.filter(i => !i.pull_request));
    if (batch.length < 100) break;
  }
  return issues;
}

/** Fetch every comment on an issue. */
async function fetchComments(issueNumber) {
  const comments = [];
  for (let page = 1; ; page++) {
    const batch = await ghGet(`/issues/${issueNumber}/comments`, { per_page: 100, page });
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

const isProposal = (body = '') => body.trimStart().startsWith('## Proposal');

const fmtDate = iso => (iso ? iso.replace('T', ' ').replace('Z', ' UTC') : '');

/** Small delay to stay well under GitHub rate limits. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠  No GITHUB_TOKEN set — limited to 60 requests/hour. Large fetches may fail.\n');
  }

  console.log(`Fetching open Bug issues from ${OWNER}/${REPO}…`);
  const allBugs = await fetchAllBugIssues();

  const helpWanted  = allBugs.filter(i =>  i.labels.some(l => l.name === 'Help Wanted')).slice(0, MAX_PER_CATEGORY);
  const noHelpWanted = allBugs.filter(i => !i.labels.some(l => l.name === 'Help Wanted')).slice(0, MAX_PER_CATEGORY);
  const toProcess   = [...helpWanted, ...noHelpWanted];

  console.log(`  Help Wanted Bugs     : ${helpWanted.length}`);
  console.log(`  Bugs (no Help Wanted): ${noHelpWanted.length}`);
  console.log(`  Total to process     : ${toProcess.length}`);
  console.log(`\nFetching comments for each issue…`);

  const issueRows   = [];
  const commentRows = [];

  for (const [idx, issue] of toProcess.entries()) {
    process.stdout.write(`  [${idx + 1}/${toProcess.length}] #${issue.number} …`);

    let comments = [];
    try {
      comments = await fetchComments(issue.number);
    } catch (err) {
      console.warn(` SKIP (${err.message})`);
      continue;
    }

    const proposalComments = comments.filter(c => isProposal(c.body));
    const regularComments  = comments.filter(c => !isProposal(c.body));
    const hasHelpWanted    = issue.labels.some(l => l.name === 'Help Wanted');

    // ── Issues sheet row ──────────────────────────────────────────────────────
    issueRows.push({
      'Issue #'               : issue.number,
      'Title'                 : cap(issue.title),
      'Category'              : hasHelpWanted ? 'Help Wanted Bug' : 'Bug (no Help Wanted)',
      'Has Help Wanted'       : hasHelpWanted ? 'Yes' : 'No',
      'State'                 : issue.state,
      'Author'                : issue.user?.login ?? '',
      'Labels'                : cap(issue.labels.map(l => l.name).join(', ')),
      'Created At'            : fmtDate(issue.created_at),
      'Updated At'            : fmtDate(issue.updated_at),
      'Issue URL'             : issue.html_url,
      'Full Body'             : cap(issue.body ?? ''),
      'Total Comments'        : comments.length,
      'Regular Comments'      : cap(regularComments
                                  .map(c => `@${c.user?.login ?? 'unknown'} (${fmtDate(c.created_at)}):\n${c.body ?? ''}`)
                                  .join('\n\n──────────────\n\n')),
      'Proposal Count'        : proposalComments.length,
      'Proposal Author(s)'    : cap(proposalComments.map(c => c.user?.login ?? '').join(', ')),
      'Proposal Comment URL'  : cap(proposalComments.map(c => c.html_url).join('\n')),
      'Proposal Comment Body' : cap(proposalComments
                                  .map(c => `@${c.user?.login ?? 'unknown'} (${fmtDate(c.created_at)}):\n${c.body ?? ''}`)
                                  .join('\n\n══════════════\n\n')),
    });

    // ── Comments sheet rows ───────────────────────────────────────────────────
    for (const [i, comment] of comments.entries()) {
      commentRows.push({
        'Issue #'     : issue.number,
        'Issue Title' : cap(issue.title),
        'Issue URL'   : issue.html_url,
        'Comment #'   : i + 1,
        'Is Proposal' : isProposal(comment.body) ? 'Yes' : 'No',
        'Author'      : comment.user?.login ?? '',
        'Created At'  : fmtDate(comment.created_at),
        'Comment URL' : comment.html_url,
        'Body'        : cap(comment.body ?? ''),
      });
    }

    process.stdout.write(` done (${comments.length} comments, ${proposalComments.length} proposal)\n`);
    await sleep(120); // ~8 req/s — safe for authenticated token
  }

  // ── Build workbook ──────────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  const wsIssues = XLSX.utils.json_to_sheet(issueRows);
  wsIssues['!cols'] = [
    { wch: 10  }, // Issue #
    { wch: 70  }, // Title
    { wch: 22  }, // Category
    { wch: 16  }, // Has Help Wanted
    { wch: 8   }, // State
    { wch: 22  }, // Author
    { wch: 45  }, // Labels
    { wch: 22  }, // Created At
    { wch: 22  }, // Updated At
    { wch: 65  }, // Issue URL
    { wch: 120 }, // Full Body
    { wch: 14  }, // Total Comments
    { wch: 120 }, // Regular Comments
    { wch: 14  }, // Proposal Count
    { wch: 30  }, // Proposal Author(s)
    { wch: 65  }, // Proposal Comment URL
    { wch: 120 }, // Proposal Comment Body
  ];
  XLSX.utils.book_append_sheet(wb, wsIssues, 'Issues');

  const wsComments = XLSX.utils.json_to_sheet(commentRows);
  wsComments['!cols'] = [
    { wch: 10  }, // Issue #
    { wch: 65  }, // Issue Title
    { wch: 65  }, // Issue URL
    { wch: 10  }, // Comment #
    { wch: 12  }, // Is Proposal
    { wch: 22  }, // Author
    { wch: 22  }, // Created At
    { wch: 65  }, // Comment URL
    { wch: 120 }, // Body
  ];
  XLSX.utils.book_append_sheet(wb, wsComments, 'All Comments');

  const outPath = join(homedir(), 'Downloads', 'expensify-bug-issues.xlsx');
  XLSX.writeFile(wb, outPath);

  console.log(`\n✓ Saved → ${outPath}`);
  console.log(`  Issues sheet  : ${issueRows.length} rows`);
  console.log(`  Comments sheet: ${commentRows.length} rows`);
}

main().catch(err => {
  console.error('\n' + err.message);
  process.exit(1);
});

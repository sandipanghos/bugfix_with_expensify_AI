/**
 * Reads expensify-bug-issues.xlsx from ~/Downloads and imports
 *   4 "Help Wanted Bug" issues  +  4 "Bug (no Help Wanted)" issues
 * into the target GitHub repo as new issues.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/import-issues.mjs
 */

import { homedir } from 'os';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as XLSX from 'xlsx';

// ── Config ────────────────────────────────────────────────────────────────────
const TARGET_OWNER = 'sandipanghos';
const TARGET_REPO  = 'App';
const COUNT_EACH   = 4; // 4 Help Wanted + 4 non-Help Wanted
const XLSX_PATH    = join(homedir(), 'Downloads', 'expensify-bug-issues.xlsx');
// ──────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN env var is required.');
  process.exit(1);
}

const BASE = `https://api.github.com/repos/${TARGET_OWNER}/${TARGET_REPO}`;
const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ghPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`GitHub ${res.status} POST ${path}: ${json.message}`);
  return json;
}

async function ghGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  const json = await res.json();
  if (!res.ok) throw new Error(`GitHub ${res.status} GET ${path}: ${json.message}`);
  return json;
}

/** Ensure a label exists in the target repo; create it if not. */
async function ensureLabel(name, color, description) {
  try {
    await ghGet(`/labels/${encodeURIComponent(name)}`);
    console.log(`  label "${name}" already exists`);
  } catch {
    await ghPost('/labels', { name, color, description });
    console.log(`  label "${name}" created`);
  }
}

async function main() {
  // ── 1. Read Excel ──────────────────────────────────────────────────────────
  console.log(`Reading ${XLSX_PATH}…`);
  const wb   = XLSX.read(readFileSync(XLSX_PATH));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Issues']);

  const helpWanted    = rows.filter(r => r['Category'] === 'Help Wanted Bug').slice(0, COUNT_EACH);
  const noHelpWanted  = rows.filter(r => r['Category'] === 'Bug (no Help Wanted)').slice(0, COUNT_EACH);
  const toImport      = [...helpWanted, ...noHelpWanted];

  console.log(`  Help Wanted to import    : ${helpWanted.length}`);
  console.log(`  No Help Wanted to import : ${noHelpWanted.length}`);

  if (toImport.length === 0) {
    console.error('No rows found — check that the Issues sheet exists and has data.');
    process.exit(1);
  }

  // ── 2. Ensure labels exist in target repo ─────────────────────────────────
  console.log(`\nEnsuring labels in ${TARGET_OWNER}/${TARGET_REPO}…`);
  await ensureLabel('Bug',        'd73a4a', 'Something is not working');
  await ensureLabel('Help Wanted','008672', 'Extra attention is needed');

  // ── 3. Create issues ───────────────────────────────────────────────────────
  console.log(`\nImporting ${toImport.length} issues into ${TARGET_OWNER}/${TARGET_REPO}…\n`);

  for (const [idx, row] of toImport.entries()) {
    const isHelpWanted = row['Has Help Wanted'] === 'Yes';
    const labels       = isHelpWanted ? ['Bug', 'Help Wanted'] : ['Bug'];
    const sourceUrl    = row['Issue URL'] ?? '';
    const sourceNum    = row['Issue #'];

    // Prepend a source attribution line so it's clear where it came from
    const body =
      `> **Imported from** [Expensify/App#${sourceNum}](${sourceUrl})\n\n` +
      (row['Full Body'] ?? '(no description)');

    process.stdout.write(`  [${idx + 1}/${toImport.length}] "${row['Title']?.slice(0, 60)}…" `);

    try {
      const created = await ghPost('/issues', {
        title: row['Title'],
        body,
        labels,
      });
      console.log(`→ #${created.number} ${created.html_url}`);
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
    }

    await sleep(500); // avoid secondary rate limits
  }

  console.log('\n✓ Done.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

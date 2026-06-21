## Proposal

### What is the root cause of that problem?

The broken-card-connection status bar banner is supposed to display whenever a `brokenCardConnection` RBR violation is present on a corporate card expense. Instead it shows nothing.

**Root cause: The card-type check in the status bar depends on a per-viewer Onyx lookup that is structurally guaranteed to fail for any non-owner.**

The header status bar logic in `MoneyRequestHeader.tsx` (and its mirror in `useMoneyReportHeaderStatusBar.ts`) determines whether to show or suppress the broken-connection message by doing:

1. Read `cardID` from the violation data.
2. Look up the card via `cardList?.[cardID]` where `cardList` comes from the `CARD_LIST` Onyx key.
3. Call `isPersonalCard(card)` — if `true`, suppress the banner entirely.

The flaw is in step 2. `CARD_LIST` is populated from the **current user's** card feed. It contains only the cards the viewing user (approver/admin) personally holds. A corporate card belonging to a workspace **member** (the expense submitter) does not appear in the approver's `CARD_LIST`. So `cardList?.[cardID]` is always `undefined` for an approver, even when the card is perfectly valid and the violation is correctly stored.

Because `card` is `undefined`, `isPersonalCard(undefined)` evaluates the guard `!card?.fundID` as `!undefined === true`, reporting "this is a personal card". The status bar then hits the early-return branch and returns `undefined` — no banner is shown. The same suppression path runs for the admin and for any reviewer who doesn't own the card.

In short: **every actor who does not personally own the violating card will get `undefined` from the Onyx lookup and will never see the broken-connection banner**, regardless of whether a null-guard like `!!card && isPersonalCard(card)` is added — because the card will always be absent from their local store.

**Affected files:**
- `src/components/MoneyRequestHeader.tsx` — `getStatusBarProps`, lines ~122–130
- `src/hooks/useMoneyReportHeaderStatusBar.ts` — broken-connection branch, lines ~111–119

### What changes do you think we should make in order to solve the problem?
<!-- DO NOT POST CODE DIFFS -->

Because the `CARD_LIST` lookup is unreliable for non-owners, the card-type inference should be removed from this code path entirely. The presence of a `brokenCardConnection` violation with a `cardID` already implies the card is a corporate card — only corporate cards tracked by the Expensify card feed produce this violation type. Personal cards produce different violation types (e.g. `receiptRequired`).

**Recommended fix:** In both `MoneyRequestHeader.tsx` and `useMoneyReportHeaderStatusBar.ts`, replace the current sequence:

> look up card → `isPersonalCard(card)` → suppress if true

with a direct check on the violation data:

> if `rterType === BROKEN_CARD_CONNECTION` AND a `cardID` is present in the violation data → always show the banner (it is, by definition, a corporate card violation)
> if `cardID` is absent → show the banner too (the violation was raised; default to surfacing the error)

The personal-card early-return branch was added to avoid showing a confusingly worded "resolve in Company Cards" message to users who broke their personal bank connection. That distinction can still be preserved, but it should be driven by the violation's own `rterType` (personal-card violations use a different type code) rather than by a per-viewer `CARD_LIST` lookup that only works for the cardholder.

**Alternative fix (lower blast radius):** If touching the violation-type logic is out of scope, the `CARD_LIST` lookup can be replaced with the workspace-scoped card feed available through `useCardFeedErrors()` → `personalCardsWithBrokenConnection`. That map is already computed over all workspace cards, not just the viewer's. A card whose ID appears in that map is a personal card; a card with a known ID that does not appear in that map is corporate; a card with no ID in the violation is treated as corporate (fail open). This avoids changing the shape of any violation type and keeps the card-type distinction intact.

### What alternative solutions did you explore? (Optional)

- **Adding `!!card && isPersonalCard(card)` at the call sites** — fixes the symptom (no longer suppresses when card is `undefined`) but does not fix the underlying scope problem. An approver still gets `card = undefined` because `CARD_LIST` doesn't include submitters' cards; the guard just changes the fallthrough behavior. The banner would appear for approvers, but for the wrong reason (the `!!card` guard, not because card type was correctly identified).
- **Backfilling `isPersonalCard` to return `false` for undefined input** — same limitation; it changes the default but still doesn't tell us what type the card actually is.
- **Sourcing card data from a workspace-level API call on render** — works but adds network latency and complexity to a render path; the `useCardFeedErrors()` data is already available in Onyx.

**Reminder:** Please use plain English, be brief and avoid jargon. Feel free to use images, charts or pseudo-code if necessary. Do not post large multi-line diffs or write walls of text. Do not create PRs unless you have been hired for this job.

<!---
ATTN: Contributor+

You are the first line of defense in making sure every proposal has a clear and easily understood problem with a "root cause". Do not approve any proposals that lack a satisfying explanation to the first two prompts. It is CRITICALLY important that we understand the root cause at a minimum even if the solution doesn't directly address it. When we avoid this step, we can end up solving the wrong problems entirely or just writing hacks and workarounds.

Instructions for how to review a proposal:

1. Address each contributor proposal one at a time and address each part of the question one at a time e.g. if a solution looks acceptable, but the stated problem is not clear, then you should provide feedback and make suggestions to improve each prompt before moving on to the next. Avoid responding to all sections of a proposal at once. Move from one question to the next each time asking the contributor to "Please update your original proposal and tag me again when it's ready for review".

2. Limit excessive conversation and moderate issues to keep them on track. If someone is doing any of the following things, please kindly and humbly course-correct them:

- Posting PRs.
- Posting large multi-line diffs (this is basically a PR).
- Skipping any of the required questions.
- Not using the proposal template at all.
- Suggesting that an existing issue is related to the current issue before a problem or root cause has been established.
- Excessively wordy explanations.

3. Choose the first proposal that has a reasonable answer to all the required questions.
-->

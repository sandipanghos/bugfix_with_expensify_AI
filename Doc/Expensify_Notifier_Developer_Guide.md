> **Note:** This file captures (1) the human Expensify contributor workflow (Upwork hiring, PR process — background context, not something this codebase automates) and (2) the original informal requirements/notes written before implementation. It is not a description of the system as built. Two notable differences from what shipped:
> - This doc says "Grace period 24 hours" (line 39) — the implemented staleness filter is **7 days**, not 24 hours, and there is no 24-hour grace-period concept anywhere in the code (see [ARCHITECTURE.md](ARCHITECTURE.md) Section 5, "Recently-created filter").
> - This doc envisions posting a proposal comment **immediately and automatically** when the watched label is added (line 50). What shipped is `POST /api/proposals` — a manually-triggered endpoint, gated by three guards (duplicate proposal, pending assigned work, similarity to existing proposals), not an automatic action taken by the poller.
>
> For the current, accurate system description, see [ARCHITECTURE.md](ARCHITECTURE.md), [README.md](README.md), and the root [CLAUDE.md](../CLAUDE.md).

# Full Workflow: Proposal → PR
## 1. Step 1: Wait for Help Wanted Label
You can only submit a proposal after Expensify adds the Help Wanted label to an issue.
Do not propose on issues without this label.
## 2. Step 2: Post Your Proposal as a Comment
Comment your proposal directly on the GitHub issue using their proposal template.
Rules:
Only one proposal per contributor per issue
Your proposal must be different from existing proposals
Don't submit if you already have an assigned issue/PR waiting on your action
## 3. Step 3: Proposal Gets Selected
An Expensify engineer reviews proposals and selects the best one.
If yours is selected, they will:
Hire you on Upwork (their payment platform)
Assign the GitHub issue to you
You must then post a comment with your expected timeline for PR readiness.
## 4. Step 4: Raise the PR
Yes — you can now raise a PR. Steps:
Fork the repo
Create a new branch
Make your changes (all commits must be GPG-signed)
Open a Pull Request, completing every checklist item
An Expensify engineer + a Contributor-Plus member are auto-assigned for review
## 5. Step 5: Stay Active During Review
Provide daily updates on weekdays
Do not go silent for more than 5 days — your contract can be terminated
Do not force push after review begins (it disrupts review history)
Summary
Stage	Who Acts
Help Wanted label added	Expensify
Proposal posted as comment	You
Proposal selected	Expensify engineer
Hired on Upwork + issue assigned	Expensify
PR raised from fork	You
Review + merge	Expensify engineer + Contributor-Plus

================================================

1. Run a schedular which send email notification to gmail of github Issues by polling based on criteria when it is created and updated . Grace period 24 hours.

2. criteria is:
 Which repository
 Which github user
 Watched labels user added to the issues  or the watched  labels is included in the list of labels applied in the issues. 
 User should also enter email address where the notification shoud be sent. 
 Per day how many issue's email notification system should sent .

3. Database should store issue url, title and issue no of those Issues only without blocking the notification (Parallaly). clicking on the title link the github issue page should open.

4. When issue have the specified label added immediately post the Proposal based on Proposal Template available on contributor guideline in a comment that issue in expensify/App or its fork repo


6. Verify if Proposal is Selected
    if 
    Hire the user who submit the proposalon Upwork (their payment platform)
    Assign the GitHub issue to user who submit the proposal

7. You must then post a comment with your expected timeline for PR readiness.

8. Don't submit Proposal in any issue if user who submit the proposal already have an assigned issue/PR waiting on his action.


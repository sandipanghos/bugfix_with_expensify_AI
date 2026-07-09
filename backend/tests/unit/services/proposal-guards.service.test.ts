import { describe, it, expect } from 'vitest';
import {
  assertProposalIsDifferent,
  GuardViolationError,
  type IssueComment,
  type ProposalParts,
} from '../../../src/services/proposal-guards.service.js';

// Builds a proposal comment body (as it would appear on GitHub) from its three sections.
function proposalComment(parts: ProposalParts): IssueComment {
  return {
    body: [
      '## Proposal',
      '### What is the root cause of that problem?',
      parts.rootCause,
      '### What changes do you think we should make in order to solve the problem?',
      parts.proposedChange,
      '### What alternative solutions did you explore? (Optional)',
      parts.alternatives,
      '**Reminder:** ...',
    ].join('\n'),
    user: { login: 'someone' },
    html_url: 'https://github.com/o/r/issues/1#c',
  };
}

const baseProposal: ProposalParts = {
  rootCause: 'The submit button handler never debounces clicks so the request fires twice rapidly',
  proposedChange: 'Wrap the submit handler in a debounce and disable the button while the request is inflight',
  alternatives: 'Considered a server-side idempotency key but that requires a backend change',
};

describe('assertProposalIsDifferent', () => {
  it('blocks a proposal whose root cause, proposed change, and alternatives are all near-identical', async () => {
    const existing = proposalComment(baseProposal);
    await expect(
      assertProposalIsDifferent([existing], { ...baseProposal })
    ).rejects.toBeInstanceOf(GuardViolationError);
  });

  it('allows a proposal when only the root cause matches but the fix and alternatives differ', async () => {
    const existing = proposalComment(baseProposal);
    await expect(
      assertProposalIsDifferent([existing], {
        rootCause: baseProposal.rootCause,
        proposedChange: 'Move the mutation into a sequential queue and dedupe by request id on the client',
        alternatives: 'Explored throttling at the network layer and a UI-level pending spinner instead',
      })
    ).resolves.toBeUndefined();
  });

  it('allows a proposal that shares the fix but has a different root cause', async () => {
    const existing = proposalComment(baseProposal);
    await expect(
      assertProposalIsDifferent([existing], {
        rootCause: 'Pagination offset is computed from the wrong page index causing skipped records',
        proposedChange: baseProposal.proposedChange,
        alternatives: baseProposal.alternatives,
      })
    ).resolves.toBeUndefined();
  });

  it('ignores comments that are not proposals', async () => {
    const chatter: IssueComment = {
      body: 'I can reproduce this on iOS as well, happy to help test.',
      user: { login: 'passerby' },
      html_url: 'https://github.com/o/r/issues/1#c2',
    };
    await expect(
      assertProposalIsDifferent([chatter], { ...baseProposal })
    ).resolves.toBeUndefined();
  });

  it('reports per-section similarity in the violation details', async () => {
    const existing = proposalComment(baseProposal);
    try {
      await assertProposalIsDifferent([existing], { ...baseProposal });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GuardViolationError);
      const details = (err as GuardViolationError).details as {
        rootCauseSim: number;
        proposedChangeSim: number;
        alternativesSim: number;
      };
      expect(details.rootCauseSim).toBeGreaterThanOrEqual(0.98);
      expect(details.proposedChangeSim).toBeGreaterThanOrEqual(0.98);
      expect(details.alternativesSim).toBeGreaterThanOrEqual(0.98);
    }
  });
});

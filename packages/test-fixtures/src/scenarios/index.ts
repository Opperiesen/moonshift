export type FixtureScenario =
  | 'PASS'
  | 'EVIDENCE_FAIL'
  | 'APPROVAL_REJECT'
  | 'INTERRUPT_BEFORE_EFFECT'
  | 'INTERRUPT_DURING_EFFECT'
  | 'INTERRUPT_AFTER_EFFECT';

export const scenarios: Record<FixtureScenario, { objective: string; expected: string }> = {
  PASS: {
    objective: 'Create a deterministic release-note artifact for the fixture',
    expected: 'PASS',
  },
  EVIDENCE_FAIL: {
    objective: 'Create an artifact with failing deterministic evidence',
    expected: 'EVIDENCE_FAIL',
  },
  APPROVAL_REJECT: {
    objective: 'Request one sensitive fixture effect',
    expected: 'APPROVAL_REJECT',
  },
  INTERRUPT_BEFORE_EFFECT: {
    objective: 'Interrupt deterministically before the fixture effect begins',
    expected: 'INTERRUPT_BEFORE_EFFECT',
  },
  INTERRUPT_DURING_EFFECT: {
    objective: 'Interrupt deterministically while the fixture effect is in flight',
    expected: 'INTERRUPT_DURING_EFFECT',
  },
  INTERRUPT_AFTER_EFFECT: {
    objective: 'Interrupt deterministically after the fixture effect reaches ground truth',
    expected: 'INTERRUPT_AFTER_EFFECT',
  },
};

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_TRANSITIONS,
  EXECUTION_TRANSITIONS,
  EXTERNAL_EFFECT_TRANSITIONS,
  PROJECT_TRANSITIONS,
  TASK_TRANSITIONS,
  applyVersionedTransition,
  assertAcyclicDependencies,
  beginExternalEffectExecution,
  canTransition,
  resolvePauseVerificationBoundary,
  transitionApproval,
  transitionExecution,
  transitionExternalEffect,
  transitionProject,
  transitionTask,
  type Actor,
  type VersionedState,
} from './state-machines.js';
import {
  APPROVAL_STATES,
  EXECUTION_STATES,
  EXTERNAL_EFFECT_STATES,
  PROJECT_STATES,
  TASK_STATES,
  asOpaqueId,
  type ExternalEffectAggregate,
  type TaskDependency,
} from './types.js';

const supervisor: Actor = { type: 'SUPERVISOR', id: '00000000-0000-4000-8000-000000000001' };
const system: Actor = { type: 'SYSTEM', id: 'scheduler' };
const runtime: Actor = { type: 'RUNTIME', id: '00000000-0000-4000-8000-000000000002' };
const verification: Actor = { type: 'VERIFICATION_ENGINE', id: 'verification-engine' };
const recovery: Actor = { type: 'RECOVERY_COORDINATOR', id: 'recovery' };
const expiry: Actor = { type: 'EXPIRY_WORKER', id: 'expiry' };
const effectAggregate: ExternalEffectAggregate = Object.freeze({
  effectId: asOpaqueId('ExternalEffect', '00000000-0000-4000-8000-000000000003'),
  actionDigest: `sha256:${'a'.repeat(64)}`,
  idempotencyKey: 'effect:fixture:marker',
  executorExecutionId: asOpaqueId('Execution', '00000000-0000-4000-8000-000000000004'),
  executorLeaseId: asOpaqueId('RunnerLease', '00000000-0000-4000-8000-000000000005'),
  executorOwnerId: runtime.id,
  executorFencingToken: 7n,
  state: 'REQUESTED',
  version: 1,
});
const currentLeaseVerifier = {
  async isCurrentFence(
    resourceType: string,
    resourceId: string,
    leaseId: string,
    ownerId: string,
    fencingToken: bigint,
  ): Promise<boolean> {
    return (
      resourceType === 'EXECUTION' &&
      resourceId === effectAggregate.executorExecutionId &&
      leaseId === effectAggregate.executorLeaseId &&
      ownerId === runtime.id &&
      fencingToken === effectAggregate.executorFencingToken
    );
  },
};

function expectMatrix<State extends string>(
  states: readonly State[],
  transitions: Readonly<Record<State, readonly State[]>>,
): void {
  for (const from of states) {
    for (const to of states) {
      expect(canTransition(transitions, from, to), `${from} -> ${to}`).toBe(
        transitions[from].includes(to),
      );
    }
  }
}

describe('authoritative state transition matrices', () => {
  it('exhaustively accepts only listed Project transitions', () => {
    expectMatrix(PROJECT_STATES, PROJECT_TRANSITIONS);
  });

  it('exhaustively accepts only listed Task transitions', () => {
    expectMatrix(TASK_STATES, TASK_TRANSITIONS);
  });

  it('exhaustively accepts only listed Execution transitions', () => {
    expectMatrix(EXECUTION_STATES, EXECUTION_TRANSITIONS);
  });

  it('exhaustively accepts only the one-way Approval decisions', () => {
    expectMatrix(APPROVAL_STATES, APPROVAL_TRANSITIONS);
  });

  it('exhaustively accepts only listed ExternalEffect transitions', () => {
    expectMatrix(EXTERNAL_EFFECT_STATES, EXTERNAL_EFFECT_TRANSITIONS);
  });
});

describe('actor authority', () => {
  it('reserves supervisor Project controls and rejects stale versions', () => {
    expect(transitionProject({ state: 'ACTIVE', version: 4 }, 'PAUSING', supervisor, 4)).toEqual({
      state: 'PAUSING',
      version: 5,
    });
    expect(() => transitionProject({ state: 'ACTIVE', version: 4 }, 'PAUSING', system, 4)).toThrow(
      /SUPERVISOR/,
    );
    expect(() =>
      transitionProject({ state: 'ACTIVE', version: 4 }, 'PAUSING', supervisor, 3),
    ).toThrow(/version/i);
  });

  it('allows VERIFIED only from the Verification Engine at a safe Project boundary', () => {
    expect(
      transitionTask({ state: 'VERIFYING', version: 8 }, 'VERIFIED', verification, 8, {
        projectState: 'PAUSING',
      }),
    ).toEqual({ state: 'VERIFIED', version: 9 });
    expect(() =>
      transitionTask({ state: 'VERIFYING', version: 8 }, 'VERIFIED', runtime, 8, {
        projectState: 'ACTIVE',
      }),
    ).toThrow(/VERIFICATION_ENGINE/);
    expect(() =>
      transitionTask({ state: 'VERIFYING', version: 8 }, 'VERIFIED', verification, 8, {
        projectState: 'PAUSED',
      }),
    ).toThrow(/PAUSED/);
  });

  it('allows approval decisions only to the proper authority', () => {
    expect(
      transitionApproval({ state: 'REQUESTED', version: 1 }, 'APPROVED', supervisor, 1),
    ).toEqual({
      state: 'APPROVED',
      version: 2,
    });
    expect(transitionApproval({ state: 'REQUESTED', version: 1 }, 'EXPIRED', expiry, 1)).toEqual({
      state: 'EXPIRED',
      version: 2,
    });
    expect(() =>
      transitionApproval({ state: 'REQUESTED', version: 1 }, 'APPROVED', runtime, 1),
    ).toThrow(/SUPERVISOR/);
  });

  it('requires a repository-verified current fence and runtime authority to begin an effect', async () => {
    await expect(
      beginExternalEffectExecution(
        effectAggregate,
        runtime,
        1,
        currentLeaseVerifier,
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).resolves.toEqual({ state: 'EXECUTING', version: 2 });
    await expect(
      beginExternalEffectExecution(
        effectAggregate,
        recovery,
        1,
        currentLeaseVerifier,
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).rejects.toThrow(/RUNTIME/);
    await expect(
      beginExternalEffectExecution(
        { ...effectAggregate, executorFencingToken: 6n },
        runtime,
        1,
        currentLeaseVerifier,
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).rejects.toThrow(/current durable runner lease/);
    await expect(
      beginExternalEffectExecution(
        effectAggregate,
        { type: 'RUNTIME', id: '00000000-0000-4000-8000-000000000099' },
        1,
        currentLeaseVerifier,
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).rejects.toThrow(/owner must match/);
    expect(() =>
      transitionExternalEffect({ state: 'REQUESTED', version: 1 }, 'EXECUTING', runtime, 1),
    ).toThrow(/beginExternalEffectExecution/);
  });

  it('requires recovery authority after an effect outcome becomes uncertain', () => {
    expect(() =>
      transitionExternalEffect({ state: 'UNKNOWN', version: 3 }, 'RECONCILING', runtime, 3),
    ).toThrow(/RECOVERY_COORDINATOR/);
    expect(
      transitionExternalEffect({ state: 'UNKNOWN', version: 3 }, 'RECONCILING', recovery, 3),
    ).toEqual({ state: 'RECONCILING', version: 4 });
  });

  it('keeps execution stop, cancel, completion, and recovery paths distinct', () => {
    expect(
      transitionExecution({ state: 'RUNNING', version: 2 }, 'STOPPING', supervisor, 2).state,
    ).toBe('STOPPING');
    expect(
      transitionExecution({ state: 'RUNNING', version: 2 }, 'SUCCEEDED', runtime, 2).state,
    ).toBe('SUCCEEDED');
    expect(
      transitionExecution({ state: 'RUNNING', version: 2 }, 'CANCELLED', supervisor, 2).state,
    ).toBe('CANCELLED');
    expect(
      transitionExecution({ state: 'LOST', version: 2 }, 'RECONCILING', recovery, 2).state,
    ).toBe('RECONCILING');
  });
});

describe('dependency and race invariants', () => {
  const projectId = asOpaqueId('Project', '00000000-0000-4000-8000-000000000010');
  const a = asOpaqueId('Task', '00000000-0000-4000-8000-000000000011');
  const b = asOpaqueId('Task', '00000000-0000-4000-8000-000000000012');
  const c = asOpaqueId('Task', '00000000-0000-4000-8000-000000000013');

  function dependency(
    predecessorTaskId: typeof a,
    successorTaskId: typeof a,
    suffix: number,
  ): TaskDependency {
    return Object.freeze({
      taskDependencyId: asOpaqueId(
        'TaskDependency',
        `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
      ),
      projectId,
      predecessorTaskId,
      successorTaskId,
      kind: 'BLOCKS',
      createdBy: supervisor.id,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }

  it('accepts immutable acyclic dependencies and rejects self, cross-project, duplicate, and cycles', () => {
    const ab = dependency(a, b, 20);
    const bc = dependency(b, c, 21);
    expect(assertAcyclicDependencies([ab, bc])).toEqual([ab, bc]);
    expect(Object.isFrozen(ab)).toBe(true);
    expect(() => assertAcyclicDependencies([dependency(a, a, 22)])).toThrow(/self/i);
    expect(() => assertAcyclicDependencies([ab, dependency(a, b, 23)])).toThrow(/duplicate/i);
    expect(() => assertAcyclicDependencies([ab, bc, dependency(c, a, 24)])).toThrow(/cycle/i);
    expect(() =>
      assertAcyclicDependencies([
        ab,
        Object.freeze({
          ...bc,
          projectId: asOpaqueId('Project', '00000000-0000-4000-8000-000000000099'),
        }),
      ]),
    ).toThrow(/project/i);
  });

  it('serializes pause versus verification at the explicit PAUSING boundary', () => {
    expect(
      resolvePauseVerificationBoundary({
        projectState: 'PAUSING',
        evaluationState: 'EVALUATING',
        graceExpired: false,
        evaluationPassed: true,
      }),
    ).toEqual({ evaluationState: 'PASSED', taskMayVerify: true, projectMayPause: true });
    expect(
      resolvePauseVerificationBoundary({
        projectState: 'PAUSING',
        evaluationState: 'EVALUATING',
        graceExpired: true,
        evaluationPassed: true,
      }),
    ).toEqual({ evaluationState: 'STALE', taskMayVerify: false, projectMayPause: true });
    expect(() =>
      resolvePauseVerificationBoundary({
        projectState: 'PAUSED',
        evaluationState: 'EVALUATING',
        graceExpired: false,
        evaluationPassed: true,
      }),
    ).toThrow(/PAUSED/);
  });

  it('makes the first pause, stop, cancel, or completion winner authoritative', () => {
    const initial: VersionedState<'ACTIVE'> = { state: 'ACTIVE', version: 9 };
    const pause = applyVersionedTransition(initial, 'PAUSING', 9, 'pause-key');
    expect(pause.aggregate).toEqual({ state: 'PAUSING', version: 10 });
    expect(
      applyVersionedTransition(pause.aggregate, 'PAUSING', 9, 'pause-key', pause.receipt),
    ).toEqual(pause);
    for (const competing of ['STOPPING', 'CANCELLING', 'COMPLETED'] as const) {
      expect(() =>
        applyVersionedTransition(pause.aggregate, competing, 9, `competing-${competing}`),
      ).toThrow(/version/i);
    }
  });
});

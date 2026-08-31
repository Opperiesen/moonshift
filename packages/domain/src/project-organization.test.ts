import { describe, expect, it } from 'vitest';

import {
  archiveProjectChannel,
  archiveSpecialist,
  createCompleteDelegation,
  createDefaultCouncil,
  createProjectChannel,
  createSpecialist,
  type CompleteDelegationInput,
} from './index.js';

const ids = {
  projectId: '10000000-0000-4000-8000-000000000001',
  policyProfileId: '10000000-0000-4000-8000-000000000002',
  permissionSetId: '10000000-0000-4000-8000-000000000003',
  routingPolicyId: '10000000-0000-4000-8000-000000000004',
  memoryScopeId: '10000000-0000-4000-8000-000000000005',
  engineeringId: '10000000-0000-4000-8000-000000000006',
  specialistId: '10000000-0000-4000-8000-000000000007',
  taskId: '10000000-0000-4000-8000-000000000008',
  delegationId: '10000000-0000-4000-8000-000000000009',
  capabilityGrantId: '10000000-0000-4000-8000-000000000010',
  budgetId: '10000000-0000-4000-8000-000000000011',
} as const;

describe('project organization', () => {
  it('creates exactly the stable Product, Engineering, and independent Quality council', () => {
    let ordinal = 20;
    const council = createDefaultCouncil({
      projectId: ids.projectId,
      policyProfileId: ids.policyProfileId,
      permissionSetId: ids.permissionSetId,
      routingPolicyId: ids.routingPolicyId,
      memoryScopeId: ids.memoryScopeId,
      nextId: () => `10000000-0000-4000-8000-${String(ordinal++).padStart(12, '0')}`,
    });

    expect(council.map(({ personaRole }) => personaRole)).toEqual([
      'PRODUCT',
      'ENGINEERING',
      'QUALITY',
    ]);
    expect(new Set(council.map(({ agentId }) => agentId)).size).toBe(3);
    expect(council[1]?.lineageId).not.toBe(council[2]?.lineageId);
    expect(council.every(({ status }) => status === 'ACTIVE')).toBe(true);
  });

  it('enforces channel count, depth, direct-child, sibling-name, and archival rules', () => {
    const root = createProjectChannel(
      {
        channelId: '10000000-0000-4000-8000-000000000101',
        projectId: ids.projectId,
        parentChannelId: null,
        name: 'Delivery',
        kind: 'CATEGORY',
        createdByAgentId: ids.engineeringId,
      },
      [],
    );
    const child = createProjectChannel(
      {
        channelId: '10000000-0000-4000-8000-000000000102',
        projectId: ids.projectId,
        parentChannelId: root.channelId,
        name: 'Implementation',
        kind: 'SUBCHANNEL',
        createdByAgentId: ids.engineeringId,
      },
      [root],
    );
    expect(child.depth).toBe(1);
    expect(() =>
      createProjectChannel({ ...child, channelId: '10000000-0000-4000-8000-000000000103' }, [
        root,
        child,
      ]),
    ).toThrow('CHANNEL_SIBLING_NAME_CONFLICT');
    expect(() =>
      createProjectChannel(
        {
          ...child,
          channelId: '10000000-0000-4000-8000-000000000104',
          name: 'Too deep',
          parentChannelId: '10000000-0000-4000-8000-000000000199',
        },
        [{ ...root, channelId: '10000000-0000-4000-8000-000000000199', depth: 4 }],
      ),
    ).toThrow('CHANNEL_DEPTH_EXCEEDED');
    expect(archiveProjectChannel(child).status).toBe('ARCHIVED');
    expect(() =>
      createProjectChannel({ ...root, channelId: '10000000-0000-4000-8000-000000000105' }, [], {
        activeMaximum: 65,
        directChildrenMaximum: 8,
        maximumDepth: 4,
      }),
    ).toThrow('CHANNEL_LIMIT_INVALID:activeMaximum');
    expect(() =>
      createProjectChannel({ ...root, channelId: '10000000-0000-4000-8000-000000000106' }, [], {
        activeMaximum: 24,
        directChildrenMaximum: 8.5,
        maximumDepth: 4,
      }),
    ).toThrow('CHANNEL_LIMIT_INVALID:directChildrenMaximum');
  });

  it('requires a complete depth-one delegation that is a capability and budget subset', () => {
    const valid: CompleteDelegationInput = {
      delegationId: ids.delegationId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      parentPersonaId: ids.engineeringId,
      specialistId: ids.specialistId,
      depth: 1,
      role: 'Release-note specialist',
      objective: 'Create the deterministic fixture artifact',
      rationale: 'Bounded implementation expertise',
      expectedOutputs: ['release-note.json'],
      requiredEvidence: ['fixture-test'],
      capabilityGrantId: ids.capabilityGrantId,
      budgetId: ids.budgetId,
      parentCapabilities: ['FIXTURE_READ', 'FIXTURE_ARTIFACT'],
      capabilities: ['FIXTURE_READ'],
      parentInvocationLimit: 4,
      invocationLimit: 2,
      parentMonetaryLimitMicros: 10_000,
      monetaryLimitMicros: 2_000,
      maxRuntimeMs: 60_000,
      taskDeadlineAt: '2026-09-01T00:00:00.000Z',
      authorityLeaseExpiresAt: '2026-08-31T21:05:00.000Z',
      terminationConditions: ['runtime exhausted', 'task cancelled'],
      archivalConditions: ['terminal state', 'required exports complete'],
    };

    expect(createCompleteDelegation(valid)).toMatchObject({ depth: 1, status: 'ACTIVE' });
    expect(() => createCompleteDelegation({ ...valid, depth: 2 })).toThrow(
      'DELEGATION_DEPTH_EXCEEDED',
    );
    expect(() =>
      createCompleteDelegation({ ...valid, capabilities: ['FIXTURE_READ', 'SHELL'] }),
    ).toThrow('CAPABILITY_ESCALATION');
    expect(() => createCompleteDelegation({ ...valid, invocationLimit: 5 })).toThrow(
      'INVOCATION_BUDGET_ESCALATION',
    );
    expect(() => createCompleteDelegation({ ...valid, requiredEvidence: [] })).toThrow(
      'DELEGATION_REQUIRED_EVIDENCE_MISSING',
    );
  });

  it('archives specialists only after terminal work and required exports', () => {
    const specialist = createSpecialist({
      agentId: ids.specialistId as never,
      projectId: ids.projectId as never,
      kind: 'SPECIALIST' as const,
      parentPersonaId: ids.engineeringId as never,
      role: 'Release-note specialist',
      objective: 'Create fixture artifact',
      lineageId: '10000000-0000-4000-8000-000000000012' as never,
      permissionSetId: ids.permissionSetId as never,
      routingPolicyId: ids.routingPolicyId as never,
      status: 'ACTIVE' as const,
      archivalConditions: ['required exports complete'],
    });
    expect(() => archiveSpecialist(specialist, true)).toThrow('WORK_NOT_TERMINAL');
    expect(() => archiveSpecialist({ ...specialist, status: 'COMPLETED' }, false)).toThrow(
      'REQUIRED_EXPORTS_MISSING',
    );
    expect(archiveSpecialist({ ...specialist, status: 'COMPLETED' }, true).status).toBe('ARCHIVED');
  });
});

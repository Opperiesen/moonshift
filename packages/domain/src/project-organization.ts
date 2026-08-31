import { asOpaqueId, type PersonaIdentity, type SpecialistIdentity } from './types.js';

export interface DefaultCouncilInput {
  readonly projectId: string;
  readonly policyProfileId: string;
  readonly permissionSetId: string;
  readonly routingPolicyId: string;
  readonly memoryScopeId: string;
  readonly nextId: () => string;
}

export interface ProjectChannel {
  readonly channelId: string;
  readonly projectId: string;
  readonly parentChannelId: string | null;
  readonly name: string;
  readonly kind: 'CATEGORY' | 'CHANNEL' | 'SUBCHANNEL';
  readonly createdByAgentId: string;
  readonly depth: number;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

export interface ChannelLimits {
  readonly activeMaximum: number;
  readonly directChildrenMaximum: number;
  readonly maximumDepth: number;
}

export const DEFAULT_CHANNEL_LIMITS: ChannelLimits = Object.freeze({
  activeMaximum: 24,
  directChildrenMaximum: 8,
  maximumDepth: 4,
});

export const MAXIMUM_CHANNEL_LIMITS: ChannelLimits = Object.freeze({
  activeMaximum: 64,
  directChildrenMaximum: 8,
  maximumDepth: 4,
});

export interface CompleteDelegationInput {
  readonly delegationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly parentPersonaId: string;
  readonly specialistId: string;
  readonly depth: number;
  readonly role: string;
  readonly objective: string;
  readonly rationale: string;
  readonly expectedOutputs: readonly string[];
  readonly requiredEvidence: readonly string[];
  readonly capabilityGrantId: string;
  readonly budgetId: string;
  readonly parentCapabilities: readonly string[];
  readonly capabilities: readonly string[];
  readonly parentInvocationLimit: number;
  readonly invocationLimit: number;
  readonly parentMonetaryLimitMicros: number;
  readonly monetaryLimitMicros: number;
  readonly maxRuntimeMs: number;
  readonly taskDeadlineAt?: string;
  readonly authorityLeaseExpiresAt: string;
  readonly terminationConditions: readonly string[];
  readonly archivalConditions: readonly string[];
}

export type CompleteDelegation = Readonly<
  Omit<CompleteDelegationInput, 'parentCapabilities'> & { readonly status: 'ACTIVE' }
>;

function requiredText(value: string, reason: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(reason);
  return normalized;
}

function requiredList(values: readonly string[], reason: string): readonly string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error(reason);
  return Object.freeze(normalized);
}

function assertNonNegativeSafeInteger(value: number, reason: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(reason);
}

export function createDefaultCouncil(input: DefaultCouncilInput): readonly PersonaIdentity[] {
  const roles = ['PRODUCT', 'ENGINEERING', 'QUALITY'] as const;
  const council = roles.map((personaRole) =>
    Object.freeze({
      agentId: asOpaqueId('Agent', input.nextId()),
      projectId: asOpaqueId('Project', input.projectId),
      kind: 'PERSONA' as const,
      personaRole,
      responsibilityVersion: 1,
      policyProfileId: asOpaqueId('PolicyProfile', input.policyProfileId),
      permissionSetId: asOpaqueId('PermissionSet', input.permissionSetId),
      routingPolicyId: asOpaqueId('RoutingPolicy', input.routingPolicyId),
      memoryScopeId: asOpaqueId('MemoryScope', input.memoryScopeId),
      lineageId: asOpaqueId('Lineage', input.nextId()),
      status: 'ACTIVE' as const,
    }),
  );
  return Object.freeze(council);
}

export function createProjectChannel(
  input: Omit<ProjectChannel, 'depth' | 'status'> &
    Partial<Pick<ProjectChannel, 'depth' | 'status'>>,
  existing: readonly ProjectChannel[],
  limits: ChannelLimits = DEFAULT_CHANNEL_LIMITS,
): ProjectChannel {
  for (const [name, value, maximum] of [
    ['activeMaximum', limits.activeMaximum, MAXIMUM_CHANNEL_LIMITS.activeMaximum],
    [
      'directChildrenMaximum',
      limits.directChildrenMaximum,
      MAXIMUM_CHANNEL_LIMITS.directChildrenMaximum,
    ],
    ['maximumDepth', limits.maximumDepth, MAXIMUM_CHANNEL_LIMITS.maximumDepth],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
      throw new Error(`CHANNEL_LIMIT_INVALID:${name}`);
  }
  const name = requiredText(input.name, 'CHANNEL_NAME_REQUIRED');
  const active = existing.filter(({ status }) => status === 'ACTIVE');
  if (active.length >= limits.activeMaximum) throw new Error('CHANNEL_CAPACITY_EXCEEDED');
  const normalizedName = name.toLocaleLowerCase('en-US');
  if (
    active.some(
      (channel) =>
        channel.parentChannelId === input.parentChannelId &&
        channel.name.trim().toLocaleLowerCase('en-US') === normalizedName,
    )
  ) {
    throw new Error('CHANNEL_SIBLING_NAME_CONFLICT');
  }
  let depth = 0;
  if (input.parentChannelId !== null) {
    const parent = active.find(({ channelId }) => channelId === input.parentChannelId);
    if (parent === undefined || parent.projectId !== input.projectId)
      throw new Error('CHANNEL_PARENT_INVALID');
    depth = parent.depth + 1;
    if (
      active.filter(({ parentChannelId }) => parentChannelId === parent.channelId).length >=
      limits.directChildrenMaximum
    ) {
      throw new Error('CHANNEL_CHILD_CAPACITY_EXCEEDED');
    }
  }
  if (depth > limits.maximumDepth) throw new Error('CHANNEL_DEPTH_EXCEEDED');
  return Object.freeze({
    ...input,
    name,
    depth,
    status: input.status ?? 'ACTIVE',
  });
}

export function archiveProjectChannel(channel: ProjectChannel): ProjectChannel {
  if (channel.status === 'ARCHIVED') return channel;
  return Object.freeze({ ...channel, status: 'ARCHIVED' });
}

export function createCompleteDelegation(input: CompleteDelegationInput): CompleteDelegation {
  if (input.depth !== 1) throw new Error('DELEGATION_DEPTH_EXCEEDED');
  const role = requiredText(input.role, 'DELEGATION_ROLE_MISSING');
  const objective = requiredText(input.objective, 'DELEGATION_OBJECTIVE_MISSING');
  const rationale = requiredText(input.rationale, 'DELEGATION_RATIONALE_MISSING');
  const expectedOutputs = requiredList(
    input.expectedOutputs,
    'DELEGATION_EXPECTED_OUTPUTS_MISSING',
  );
  const requiredEvidence = requiredList(
    input.requiredEvidence,
    'DELEGATION_REQUIRED_EVIDENCE_MISSING',
  );
  const terminationConditions = requiredList(
    input.terminationConditions,
    'DELEGATION_TERMINATION_CONDITIONS_MISSING',
  );
  const archivalConditions = requiredList(
    input.archivalConditions,
    'DELEGATION_ARCHIVAL_CONDITIONS_MISSING',
  );
  if (!input.capabilities.every((capability) => input.parentCapabilities.includes(capability)))
    throw new Error('CAPABILITY_ESCALATION');
  assertNonNegativeSafeInteger(input.parentInvocationLimit, 'INVALID_PARENT_BUDGET');
  assertNonNegativeSafeInteger(input.invocationLimit, 'INVALID_CHILD_BUDGET');
  assertNonNegativeSafeInteger(input.parentMonetaryLimitMicros, 'INVALID_PARENT_BUDGET');
  assertNonNegativeSafeInteger(input.monetaryLimitMicros, 'INVALID_CHILD_BUDGET');
  if (input.invocationLimit > input.parentInvocationLimit)
    throw new Error('INVOCATION_BUDGET_ESCALATION');
  if (input.monetaryLimitMicros > input.parentMonetaryLimitMicros)
    throw new Error('MONETARY_BUDGET_ESCALATION');
  if (!Number.isSafeInteger(input.maxRuntimeMs) || input.maxRuntimeMs <= 0)
    throw new Error('DELEGATION_RUNTIME_INVALID');
  if (!Number.isFinite(Date.parse(input.authorityLeaseExpiresAt)))
    throw new Error('DELEGATION_AUTHORITY_LEASE_INVALID');
  if (input.taskDeadlineAt !== undefined && !Number.isFinite(Date.parse(input.taskDeadlineAt)))
    throw new Error('DELEGATION_TASK_DEADLINE_INVALID');
  const { parentCapabilities: _parentCapabilities, ...delegation } = input;
  return Object.freeze({
    ...delegation,
    role,
    objective,
    rationale,
    expectedOutputs,
    requiredEvidence,
    capabilities: Object.freeze([...input.capabilities]),
    terminationConditions,
    archivalConditions,
    status: 'ACTIVE' as const,
  });
}

export function archiveSpecialist(
  specialist: SpecialistIdentity,
  requiredExportsComplete: boolean,
): SpecialistIdentity {
  if (specialist.status !== 'COMPLETED' && specialist.status !== 'FAILED')
    throw new Error('WORK_NOT_TERMINAL');
  if (!requiredExportsComplete) throw new Error('REQUIRED_EXPORTS_MISSING');
  return Object.freeze({ ...specialist, status: 'ARCHIVED' });
}

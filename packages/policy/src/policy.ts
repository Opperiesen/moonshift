export interface PolicyProfile {
  readonly profileId: string;
  readonly version: number;
  readonly personas: {
    readonly minimum: number;
    readonly default: number;
    readonly maximum: number;
  };
  readonly specialists: {
    readonly defaultProjectMaximum: number;
    readonly projectMaximum: number;
    readonly perPersonaMaximum: number;
    readonly maximumDepth: number;
  };
  readonly cognitiveConcurrency: { readonly default: number; readonly maximum: number };
  readonly runnerConcurrency: number;
  readonly contextClassifications: readonly string[];
}

export const DEFAULT_POLICY_PROFILE: PolicyProfile = deepFreeze({
  profileId: 'moonshift-foundation',
  version: 1,
  personas: { minimum: 2, default: 3, maximum: 6 },
  specialists: {
    defaultProjectMaximum: 4,
    projectMaximum: 8,
    perPersonaMaximum: 3,
    maximumDepth: 1,
  },
  cognitiveConcurrency: { default: 3, maximum: 5 },
  runnerConcurrency: 1,
  contextClassifications: ['PUBLIC', 'INTERNAL', 'RESTRICTED'],
});

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === 'object') deepFreeze(nested as object);
  }
  return Object.freeze(value);
}

function assertSafePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

export function validatePolicyProfile(profile: PolicyProfile): PolicyProfile {
  assertSafePositiveInteger(profile.version, 'Policy version');
  assertSafePositiveInteger(profile.personas.minimum, 'Minimum persona count');
  assertSafePositiveInteger(profile.personas.default, 'Default persona count');
  assertSafePositiveInteger(profile.personas.maximum, 'Maximum persona count');
  assertSafeNonNegativeInteger(
    profile.specialists.defaultProjectMaximum,
    'Default project specialist maximum',
  );
  assertSafeNonNegativeInteger(profile.specialists.projectMaximum, 'Project specialist maximum');
  assertSafeNonNegativeInteger(
    profile.specialists.perPersonaMaximum,
    'Per-persona specialist maximum',
  );
  assertSafeNonNegativeInteger(profile.specialists.maximumDepth, 'Maximum delegation depth');
  assertSafePositiveInteger(profile.cognitiveConcurrency.default, 'Default cognitive concurrency');
  assertSafePositiveInteger(profile.cognitiveConcurrency.maximum, 'Maximum cognitive concurrency');
  assertSafePositiveInteger(profile.runnerConcurrency, 'Runner concurrency');

  if (profile.personas.minimum < 2 || profile.personas.maximum > 6)
    throw new Error('Persona policy exceeds constitutional limits');
  if (
    profile.personas.default < profile.personas.minimum ||
    profile.personas.default > profile.personas.maximum
  )
    throw new Error('Default persona count is outside its bounds');
  if (
    profile.specialists.defaultProjectMaximum > profile.specialists.projectMaximum ||
    profile.specialists.defaultProjectMaximum > 4 ||
    profile.specialists.projectMaximum > 8
  )
    throw new Error('Specialist policy exceeds constitutional limits');
  if (
    profile.specialists.perPersonaMaximum > profile.specialists.projectMaximum ||
    profile.specialists.perPersonaMaximum > 3 ||
    profile.specialists.maximumDepth !== 1
  )
    throw new Error('Delegation policy exceeds constitutional limits');
  if (
    profile.cognitiveConcurrency.default > profile.cognitiveConcurrency.maximum ||
    profile.cognitiveConcurrency.default > 3 ||
    profile.cognitiveConcurrency.maximum > 5
  )
    throw new Error('Cognitive concurrency exceeds constitutional limits');
  if (profile.runnerConcurrency !== 1) throw new Error('Foundation permits exactly one runner job');
  return profile;
}

export interface PolicyDecision<Reason extends string = string> {
  readonly allowed: boolean;
  readonly reason: Reason;
}

export function evaluateOrganizationCeilings(
  profile: PolicyProfile,
  counts: {
    readonly personas: number;
    readonly specialists: number;
    readonly perPersona: number;
    readonly depth: number;
  },
): PolicyDecision {
  validatePolicyProfile(profile);
  assertSafeNonNegativeInteger(counts.personas, 'Persona count');
  assertSafeNonNegativeInteger(counts.specialists, 'Specialist count');
  assertSafeNonNegativeInteger(counts.perPersona, 'Per-persona specialist count');
  assertSafeNonNegativeInteger(counts.depth, 'Delegation depth');
  if (counts.personas < profile.personas.minimum)
    return { allowed: false, reason: 'PERSONA_FLOOR' };
  if (counts.personas > profile.personas.maximum)
    return { allowed: false, reason: 'PERSONA_CEILING' };
  if (counts.specialists > profile.specialists.projectMaximum)
    return { allowed: false, reason: 'SPECIALIST_CEILING' };
  if (counts.perPersona > profile.specialists.perPersonaMaximum)
    return { allowed: false, reason: 'PER_PERSONA_CEILING' };
  if (counts.depth > profile.specialists.maximumDepth)
    return { allowed: false, reason: 'DELEGATION_DEPTH' };
  return { allowed: true, reason: 'WITHIN_CEILINGS' };
}

export interface CapabilityGrant {
  readonly grantId: string;
  readonly capabilities: readonly string[];
  readonly resourceScopes: readonly string[];
  readonly invocationLimit: number;
  readonly monetaryLimitMicros: number;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

export interface ChildCapabilityGrant {
  readonly grantId: string;
  readonly capabilities: readonly string[];
  readonly resourceScopes: readonly string[];
  readonly invocationLimit: number;
  readonly monetaryLimitMicros: number;
  readonly expiresAt: string;
}

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  return child.every((value) => parent.includes(value));
}

const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseRfc3339(value: string): number | null {
  const match = RFC3339_DATE_TIME.exec(value);
  if (match === null) return null;
  const [
    ,
    yearValue,
    monthValue,
    dayValue,
    hourValue,
    minuteValue,
    secondValue,
    ,
    offsetHourValue,
    offsetMinuteValue,
  ] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    Number(hourValue) > 23 ||
    Number(minuteValue) > 59 ||
    Number(secondValue) > 59 ||
    Number(offsetHourValue ?? 0) > 23 ||
    Number(offsetMinuteValue ?? 0) > 59
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function assertBudget(value: number, reason: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(reason);
}

export function deriveCapabilityGrant(
  parent: CapabilityGrant,
  child: ChildCapabilityGrant,
): CapabilityGrant {
  if (parent.revoked) throw new Error('PARENT_GRANT_REVOKED');
  assertBudget(parent.invocationLimit, 'INVALID_PARENT_BUDGET');
  assertBudget(parent.monetaryLimitMicros, 'INVALID_PARENT_BUDGET');
  assertBudget(child.invocationLimit, 'INVALID_CHILD_BUDGET');
  assertBudget(child.monetaryLimitMicros, 'INVALID_CHILD_BUDGET');
  if (!isSubset(child.capabilities, parent.capabilities)) throw new Error('CAPABILITY_ESCALATION');
  if (!isSubset(child.resourceScopes, parent.resourceScopes))
    throw new Error('RESOURCE_SCOPE_ESCALATION');
  if (child.invocationLimit > parent.invocationLimit)
    throw new Error('INVOCATION_BUDGET_ESCALATION');
  if (child.monetaryLimitMicros > parent.monetaryLimitMicros)
    throw new Error('MONETARY_BUDGET_ESCALATION');
  const parentExpiry = parseRfc3339(parent.expiresAt);
  const childExpiry = parseRfc3339(child.expiresAt);
  if (parentExpiry === null || childExpiry === null) throw new Error('INVALID_GRANT_EXPIRY');
  if (childExpiry > parentExpiry) throw new Error('EXPIRY_ESCALATION');
  return deepFreeze({
    ...child,
    capabilities: [...child.capabilities],
    resourceScopes: [...child.resourceScopes],
    revoked: false,
  });
}

export interface RuntimeAuthorityInput {
  readonly maxRuntimeMs: number;
  readonly consumedActiveMs: number;
  readonly attemptedActiveMs: number;
  readonly authorityLeaseExpiresAt: string;
  readonly now: string;
}

export interface RuntimeAuthorityDecision extends PolicyDecision {
  readonly remainingRuntimeMs: number;
}

export function evaluateRuntimeAuthority(input: RuntimeAuthorityInput): RuntimeAuthorityDecision {
  if (
    !Number.isSafeInteger(input.maxRuntimeMs) ||
    !Number.isSafeInteger(input.consumedActiveMs) ||
    !Number.isSafeInteger(input.attemptedActiveMs) ||
    input.maxRuntimeMs <= 0 ||
    input.consumedActiveMs < 0 ||
    input.attemptedActiveMs < 0
  )
    throw new Error('Runtime budgets must be valid positive durations');
  const remainingRuntimeMs = Math.max(0, input.maxRuntimeMs - input.consumedActiveMs);
  const now = parseRfc3339(input.now);
  const leaseExpiry = parseRfc3339(input.authorityLeaseExpiresAt);
  if (now === null || leaseExpiry === null) {
    return { allowed: false, reason: 'INVALID_AUTHORITY_TIME', remainingRuntimeMs };
  }
  if (now >= leaseExpiry) {
    return { allowed: false, reason: 'AUTHORITY_LEASE_EXPIRED', remainingRuntimeMs };
  }
  if (input.attemptedActiveMs > remainingRuntimeMs) {
    return { allowed: false, reason: 'MAX_RUNTIME_EXHAUSTED', remainingRuntimeMs };
  }
  return {
    allowed: true,
    reason: 'RUNTIME_AVAILABLE',
    remainingRuntimeMs: remainingRuntimeMs - input.attemptedActiveMs,
  };
}

export function evaluateTaskDeadline(deadlineAt: string | undefined, now: string): PolicyDecision {
  const currentTime = parseRfc3339(now);
  if (currentTime === null) return { allowed: false, reason: 'INVALID_TASK_DEADLINE_TIME' };
  if (deadlineAt === undefined) return { allowed: true, reason: 'NO_TASK_DEADLINE' };
  const deadline = parseRfc3339(deadlineAt);
  if (deadline === null) return { allowed: false, reason: 'INVALID_TASK_DEADLINE_TIME' };
  if (currentTime >= deadline) return { allowed: false, reason: 'TASK_DEADLINE_EXPIRED' };
  return { allowed: true, reason: 'TASK_DEADLINE_AVAILABLE' };
}

export function evaluateArchiveEligibility(input: {
  readonly identityState: 'CREATED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'ARCHIVED';
  readonly requiredExportsComplete: boolean;
}): PolicyDecision {
  if (input.identityState !== 'COMPLETED' && input.identityState !== 'FAILED')
    return { allowed: false, reason: 'WORK_NOT_TERMINAL' };
  if (!input.requiredExportsComplete) return { allowed: false, reason: 'REQUIRED_EXPORTS_MISSING' };
  return { allowed: true, reason: 'ARCHIVE_ALLOWED' };
}

export function validateReviewerLineage(
  authoringLineageId: string,
  reviewerLineageId: string,
): PolicyDecision {
  return authoringLineageId === reviewerLineageId
    ? { allowed: false, reason: 'SAME_LINEAGE' }
    : { allowed: true, reason: 'INDEPENDENT_LINEAGE' };
}

export type PolicyActor =
  'SUPERVISOR' | 'PERSONA' | 'SPECIALIST' | 'VERIFICATION_ENGINE' | 'SYSTEM';
export type GovernedAction =
  | 'DECIDE_APPROVAL'
  | 'INCREASE_OWN_GRANT'
  | 'CREATE_SPECIALIST'
  | 'VERIFY_TASK'
  | 'RUN_GRANTED_TOOL';

export function evaluateActorAuthority(input: {
  readonly actor: PolicyActor;
  readonly action: GovernedAction;
  readonly requesterIsActor: boolean;
}): PolicyDecision {
  if (input.action === 'DECIDE_APPROVAL') {
    if (input.requesterIsActor) return { allowed: false, reason: 'SELF_APPROVAL_DENIED' };
    return input.actor === 'SUPERVISOR'
      ? { allowed: true, reason: 'SUPERVISOR_AUTHORIZED' }
      : { allowed: false, reason: 'SUPERVISOR_ONLY' };
  }
  if (input.action === 'INCREASE_OWN_GRANT')
    return { allowed: false, reason: 'SELF_ESCALATION_DENIED' };
  if (input.action === 'CREATE_SPECIALIST' && input.actor === 'SPECIALIST')
    return { allowed: false, reason: 'SPECIALIST_CHILD_DENIED' };
  if (input.action === 'VERIFY_TASK') {
    return input.actor === 'VERIFICATION_ENGINE'
      ? { allowed: true, reason: 'VERIFICATION_ENGINE_AUTHORIZED' }
      : { allowed: false, reason: 'VERIFICATION_ENGINE_ONLY' };
  }
  return { allowed: true, reason: 'AUTHORIZED' };
}

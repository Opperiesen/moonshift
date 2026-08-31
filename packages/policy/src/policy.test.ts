import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY_PROFILE,
  deriveCapabilityGrant,
  evaluateActorAuthority,
  evaluateArchiveEligibility,
  evaluateOrganizationCeilings,
  evaluateRuntimeAuthority,
  evaluateTaskDeadline,
  validatePolicyProfile,
  validateReviewerLineage,
  type CapabilityGrant,
  type PolicyProfile,
} from './policy.js';

const parentGrant: CapabilityGrant = Object.freeze({
  grantId: 'grant-parent',
  capabilities: Object.freeze(['READ_FIXTURE', 'WRITE_APPROVED_MARKER']),
  resourceScopes: Object.freeze(['fixture:repository', 'fixture:approved-marker']),
  invocationLimit: 10,
  monetaryLimitMicros: 50_000,
  expiresAt: '2026-01-01T01:00:00.000Z',
  revoked: false,
});

describe('versioned policy profiles and organization ceilings', () => {
  it('validates the accepted defaults and hard ceilings', () => {
    expect(validatePolicyProfile(DEFAULT_POLICY_PROFILE)).toEqual(DEFAULT_POLICY_PROFILE);
    expect(DEFAULT_POLICY_PROFILE).toMatchObject({
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
    });
  });

  it.each([
    ['version', Number.NaN],
    ['personas.minimum', Number.POSITIVE_INFINITY],
    ['personas.default', 1.5],
    ['personas.maximum', Number.MAX_SAFE_INTEGER + 1],
    ['specialists.defaultProjectMaximum', -1],
  ] as const)('rejects invalid nested number %s', (path, value) => {
    const [section, field] = path.split('.') as [string, string?];
    const profile = structuredClone(DEFAULT_POLICY_PROFILE) as Record<string, any>;
    if (field === undefined) profile[section] = value;
    else (profile[section] as Record<string, unknown>)[field] = value;
    expect(() => validatePolicyProfile(profile as PolicyProfile)).toThrow();
  });

  it.each([
    ['personas.default below minimum', { personas: { minimum: 4 } }],
    ['personas.default above maximum', { personas: { maximum: 2 } }],
    ['specialist default above project maximum', { specialists: { defaultProjectMaximum: 9 } }],
    ['per-persona maximum above project maximum', { specialists: { projectMaximum: 2 } }],
    ['cognitive default above maximum', { cognitiveConcurrency: { maximum: 2 } }],
  ] as const)('rejects incoherent profile relation: %s', (_description, override) => {
    const profile = structuredClone(DEFAULT_POLICY_PROFILE) as any;
    for (const [section, values] of Object.entries(override))
      Object.assign(profile[section], values);
    expect(() => validatePolicyProfile(profile)).toThrow();
  });

  it('denies organization creation outside every bound', () => {
    expect(
      evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
        personas: 3,
        specialists: 4,
        perPersona: 2,
        depth: 1,
      }),
    ).toEqual({ allowed: true, reason: 'WITHIN_CEILINGS' });
    for (const personas of [0, 1]) {
      expect(
        evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
          personas,
          specialists: 0,
          perPersona: 0,
          depth: 0,
        }),
      ).toEqual({ allowed: false, reason: 'PERSONA_FLOOR' });
    }
    expect(
      evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
        personas: 7,
        specialists: 0,
        perPersona: 0,
        depth: 0,
      }).reason,
    ).toBe('PERSONA_CEILING');
    expect(
      evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
        personas: 3,
        specialists: 9,
        perPersona: 2,
        depth: 1,
      }).reason,
    ).toBe('SPECIALIST_CEILING');
    expect(
      evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
        personas: 3,
        specialists: 3,
        perPersona: 4,
        depth: 1,
      }).reason,
    ).toBe('PER_PERSONA_CEILING');
    expect(
      evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
        personas: 3,
        specialists: 3,
        perPersona: 2,
        depth: 2,
      }).reason,
    ).toBe('DELEGATION_DEPTH');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid organization counters: %s',
    (invalid) => {
      expect(() =>
        evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
          personas: invalid,
          specialists: 0,
          perPersona: 0,
          depth: 0,
        }),
      ).toThrow();
    },
  );
});

describe('delegation subsets and budgets', () => {
  it('derives an immutable capability, resource, invocation, and monetary subset', () => {
    const child = deriveCapabilityGrant(parentGrant, {
      grantId: 'grant-child',
      capabilities: ['READ_FIXTURE'],
      resourceScopes: ['fixture:repository'],
      invocationLimit: 4,
      monetaryLimitMicros: 10_000,
      expiresAt: '2026-01-01T00:30:00.000Z',
    });
    expect(child).toMatchObject({
      capabilities: ['READ_FIXTURE'],
      invocationLimit: 4,
      revoked: false,
    });
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.capabilities)).toBe(true);
  });

  it.each([
    [{ capabilities: ['SPAWN_CHILD'] }, 'CAPABILITY_ESCALATION'],
    [{ resourceScopes: ['host:filesystem'] }, 'RESOURCE_SCOPE_ESCALATION'],
    [{ invocationLimit: 11 }, 'INVOCATION_BUDGET_ESCALATION'],
    [{ monetaryLimitMicros: 50_001 }, 'MONETARY_BUDGET_ESCALATION'],
    [{ expiresAt: '2026-01-01T02:00:00.000Z' }, 'EXPIRY_ESCALATION'],
  ] as const)('rejects a child grant outside its parent: %s', (override, reason) => {
    expect(() =>
      deriveCapabilityGrant(parentGrant, {
        grantId: 'grant-child',
        capabilities: ['READ_FIXTURE'],
        resourceScopes: ['fixture:repository'],
        invocationLimit: 4,
        monetaryLimitMicros: 10_000,
        expiresAt: '2026-01-01T00:30:00.000Z',
        ...override,
      }),
    ).toThrow(reason);
  });

  it.each(['not-a-date', '2026-02-30T00:00:00Z', '2026-01-01 00:00:00Z'])(
    'rejects malformed child grant expiry %s',
    (expiresAt) => {
      expect(() =>
        deriveCapabilityGrant(parentGrant, {
          grantId: 'grant-child',
          capabilities: ['READ_FIXTURE'],
          resourceScopes: ['fixture:repository'],
          invocationLimit: 4,
          monetaryLimitMicros: 10_000,
          expiresAt,
        }),
      ).toThrow('INVALID_GRANT_EXPIRY');
    },
  );
});

describe('runtime, task deadline, lease, termination, and archival semantics', () => {
  it('accounts only cumulative active compute against max runtime', () => {
    expect(
      evaluateRuntimeAuthority({
        maxRuntimeMs: 60_000,
        consumedActiveMs: 45_000,
        attemptedActiveMs: 10_000,
        authorityLeaseExpiresAt: '2026-01-01T00:01:00.000Z',
        now: '2026-01-01T00:00:30.000Z',
      }),
    ).toEqual({ allowed: true, reason: 'RUNTIME_AVAILABLE', remainingRuntimeMs: 5_000 });
    expect(
      evaluateRuntimeAuthority({
        maxRuntimeMs: 60_000,
        consumedActiveMs: 55_000,
        attemptedActiveMs: 10_000,
        authorityLeaseExpiresAt: '2026-01-01T00:01:00.000Z',
        now: '2026-01-01T00:00:30.000Z',
      }).reason,
    ).toBe('MAX_RUNTIME_EXHAUSTED');
  });

  it('treats task deadline and short authority lease expiry as distinct outcomes', () => {
    expect(evaluateTaskDeadline(undefined, '2026-01-01T00:00:00.000Z')).toEqual({
      allowed: true,
      reason: 'NO_TASK_DEADLINE',
    });
    expect(
      evaluateTaskDeadline('2025-12-31T23:59:59.000Z', '2026-01-01T00:00:00.000Z').reason,
    ).toBe('TASK_DEADLINE_EXPIRED');
    const expiredLease = evaluateRuntimeAuthority({
      maxRuntimeMs: 60_000,
      consumedActiveMs: 5_000,
      attemptedActiveMs: 0,
      authorityLeaseExpiresAt: '2025-12-31T23:59:59.000Z',
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(expiredLease).toEqual({
      allowed: false,
      reason: 'AUTHORITY_LEASE_EXPIRED',
      remainingRuntimeMs: 55_000,
    });
  });

  it('fails closed for malformed authority lease and task deadline timestamps', () => {
    expect(
      evaluateRuntimeAuthority({
        maxRuntimeMs: 60_000,
        consumedActiveMs: 5_000,
        attemptedActiveMs: 1_000,
        authorityLeaseExpiresAt: 'not-a-date',
        now: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      allowed: false,
      reason: 'INVALID_AUTHORITY_TIME',
      remainingRuntimeMs: 55_000,
    });
    expect(evaluateTaskDeadline('2026-02-30T00:00:00Z', '2026-01-01T00:00:00Z')).toEqual({
      allowed: false,
      reason: 'INVALID_TASK_DEADLINE_TIME',
    });
    expect(evaluateTaskDeadline(undefined, 'not-a-date')).toEqual({
      allowed: false,
      reason: 'INVALID_TASK_DEADLINE_TIME',
    });
  });

  it('archives only terminal specialists whose required exports are complete', () => {
    expect(
      evaluateArchiveEligibility({ identityState: 'ACTIVE', requiredExportsComplete: true }).reason,
    ).toBe('WORK_NOT_TERMINAL');
    expect(
      evaluateArchiveEligibility({ identityState: 'COMPLETED', requiredExportsComplete: false })
        .reason,
    ).toBe('REQUIRED_EXPORTS_MISSING');
    expect(
      evaluateArchiveEligibility({ identityState: 'FAILED', requiredExportsComplete: true }),
    ).toEqual({ allowed: true, reason: 'ARCHIVE_ALLOWED' });
  });
});

describe('lineage and actor authority', () => {
  it('requires a reviewer outside the authoring lineage', () => {
    expect(validateReviewerLineage('engineering-lineage', 'quality-lineage')).toEqual({
      allowed: true,
      reason: 'INDEPENDENT_LINEAGE',
    });
    expect(validateReviewerLineage('engineering-lineage', 'engineering-lineage')).toEqual({
      allowed: false,
      reason: 'SAME_LINEAGE',
    });
  });

  it('denies self approval, self escalation, and specialist child spawning by default', () => {
    expect(
      evaluateActorAuthority({
        actor: 'SUPERVISOR',
        action: 'DECIDE_APPROVAL',
        requesterIsActor: false,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateActorAuthority({
        actor: 'SPECIALIST',
        action: 'DECIDE_APPROVAL',
        requesterIsActor: true,
      }).reason,
    ).toBe('SELF_APPROVAL_DENIED');
    expect(
      evaluateActorAuthority({
        actor: 'SPECIALIST',
        action: 'INCREASE_OWN_GRANT',
        requesterIsActor: true,
      }).reason,
    ).toBe('SELF_ESCALATION_DENIED');
    expect(
      evaluateActorAuthority({
        actor: 'SPECIALIST',
        action: 'CREATE_SPECIALIST',
        requesterIsActor: false,
      }).reason,
    ).toBe('SPECIALIST_CHILD_DENIED');
    expect(
      evaluateActorAuthority({
        actor: 'VERIFICATION_ENGINE',
        action: 'VERIFY_TASK',
        requesterIsActor: false,
      }).allowed,
    ).toBe(true);
  });
});

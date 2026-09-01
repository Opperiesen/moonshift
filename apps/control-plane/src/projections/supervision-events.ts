import type {
  ProjectEvent,
  ProjectRecord,
  SupervisionAuditProjection,
  SupervisionRecord,
} from '../model.js';
import { ProjectEventSequence } from './project-events.js';

type EventDescriptor = {
  readonly kind: ProjectEvent['kind'];
  readonly actor: ProjectEvent['actor'];
  readonly aggregate: ProjectEvent['aggregate'];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly classification?: ProjectEvent['classification'];
};

type AuditDescriptor = Omit<
  SupervisionAuditProjection,
  'auditEventId' | 'sequence' | 'occurredAt' | 'correlationId'
>;

function audit(
  descriptor: AuditDescriptor,
  sequence: number,
  occurredAt: string,
  correlationId: string,
  nextId: () => string,
): SupervisionAuditProjection {
  return Object.freeze({
    auditEventId: nextId(),
    sequence,
    occurredAt,
    correlationId,
    ...descriptor,
  });
}

export function appendInitialSupervisionEvents(input: {
  readonly sequence: ProjectEventSequence;
  readonly supervision: SupervisionRecord;
  readonly specialistId: string;
  readonly specialistLineageId: string;
  readonly systemId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly nextId: () => string;
}): readonly SupervisionAuditProjection[] {
  const approval = input.supervision.approvals[0];
  const effect = input.supervision.effects[0];
  if (approval === undefined || effect === undefined) return Object.freeze([]);
  input.sequence.append({
    kind: 'tool.requested',
    actor: {
      type: 'SPECIALIST',
      id: input.specialistId,
      lineageId: input.specialistLineageId,
    },
    aggregate: {
      type: 'TOOL_INVOCATION',
      id: input.supervision.toolInvocationId,
      version: 1,
    },
    payload: {
      activity: 'WRITE_APPROVED_MARKER',
      status: 'WAITING_FOR_APPROVAL',
      summary: 'Specialist requested one bounded fixture effect',
      referenceId: input.supervision.toolInvocationId,
      actionDigest: approval.actionDigest,
    },
  });
  input.sequence.append({
    kind: 'policy.decided',
    actor: { type: 'SYSTEM', id: input.systemId },
    aggregate: {
      type: 'TOOL_INVOCATION',
      id: input.supervision.toolInvocationId,
      version: 1,
    },
    payload: {
      decision: 'APPROVAL_REQUIRED',
      reasonCode: 'SENSITIVE_FIXTURE_EFFECT',
      summary: 'Capability, resource, arguments, lease, and budget permit an approval request',
    },
  });
  input.sequence.append({
    kind: 'approval.requested',
    actor: { type: 'SYSTEM', id: input.systemId },
    aggregate: { type: 'APPROVAL', id: approval.approvalId, version: approval.version },
    payload: {
      referenceType: 'APPROVAL',
      referenceId: approval.approvalId,
      contentHash: approval.actionDigest,
      summary: 'Supervisor decision requested for the exact fixture action',
    },
  });
  const descriptors: readonly AuditDescriptor[] = [
    {
      actorType: 'SPECIALIST',
      actorId: input.specialistId,
      action: 'tool.requested',
      targetType: 'TOOL_INVOCATION',
      targetId: input.supervision.toolInvocationId,
      reason: 'Bounded fixture tool intent',
      outcome: 'WAITING_FOR_APPROVAL',
    },
    {
      actorType: 'SYSTEM',
      actorId: input.systemId,
      action: 'policy.decided',
      targetType: 'TOOL_INVOCATION',
      targetId: input.supervision.toolInvocationId,
      reason: 'Sensitive effects require supervisor approval',
      outcome: 'APPROVAL_REQUIRED',
    },
    {
      actorType: 'SYSTEM',
      actorId: input.systemId,
      action: 'approval.requested',
      targetType: 'APPROVAL',
      targetId: approval.approvalId,
      reason: approval.reason,
      outcome: 'REQUESTED',
    },
  ];
  return Object.freeze(
    descriptors.map((descriptor, index) =>
      audit(descriptor, index + 1, input.occurredAt, input.correlationId, input.nextId),
    ),
  );
}

export function appendSupervisionMutation(input: {
  readonly record: ProjectRecord;
  readonly events: readonly EventDescriptor[];
  readonly audits: readonly AuditDescriptor[];
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly nextId: () => string;
}): {
  readonly events: readonly ProjectEvent[];
  readonly audit: readonly SupervisionAuditProjection[];
} {
  const sequence = new ProjectEventSequence(
    input.record.view.projectId,
    input.correlationId,
    input.occurredAt,
    input.nextId,
    input.record.view.lastSequence,
  );
  for (const descriptor of input.events) sequence.append(descriptor);
  const priorAuditSequence = input.record.supervision.audit.at(-1)?.sequence ?? 0;
  const appendedAudit = input.audits.map((descriptor, index) =>
    audit(
      descriptor,
      priorAuditSequence + index + 1,
      input.occurredAt,
      input.correlationId,
      input.nextId,
    ),
  );
  return Object.freeze({
    events: sequence.snapshot(),
    audit: Object.freeze([...input.record.supervision.audit, ...appendedAudit]),
  });
}

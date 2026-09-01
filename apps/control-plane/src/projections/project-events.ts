import { planningValidators } from '@moonshift/contracts';

import type { EventKind, ProjectEvent } from '../model.js';

export class ProjectEventSequence {
  private sequence = 0;
  private readonly events: ProjectEvent[] = [];

  constructor(
    private readonly projectId: string,
    private readonly correlationId: string,
    private readonly occurredAt: string,
    private readonly nextId: () => string,
    initialSequence = 0,
  ) {
    this.sequence = initialSequence;
  }

  append(input: {
    readonly kind: EventKind;
    readonly actor: ProjectEvent['actor'];
    readonly aggregate: ProjectEvent['aggregate'];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly classification?: ProjectEvent['classification'];
  }): ProjectEvent {
    this.sequence += 1;
    const event: ProjectEvent = Object.freeze({
      schemaVersion: '1.0',
      eventId: this.nextId(),
      projectId: this.projectId,
      sequence: this.sequence,
      kind: input.kind,
      occurredAt: this.occurredAt,
      actor: Object.freeze({ ...input.actor }),
      aggregate: Object.freeze({ ...input.aggregate }),
      correlationId: this.correlationId,
      classification: input.classification ?? 'INSTANCE_INTERNAL',
      payload: Object.freeze({ ...input.payload }),
    });
    planningValidators().eventEnvelope.assert(event);
    this.events.push(event);
    return event;
  }

  snapshot(): readonly ProjectEvent[] {
    return Object.freeze([...this.events]);
  }
}

export function formatProjectEventsAsSse(events: readonly ProjectEvent[]): string {
  return events
    .map(
      (event) => `id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
}

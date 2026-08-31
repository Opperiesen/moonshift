import type { Actor, VersionedState } from './state-machines.js';

export interface DomainCommand<State extends string> {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly actor: Actor;
  readonly expectedVersion: number;
  readonly targetState: State;
  readonly correlationId: string;
}

export interface DomainTransition<State extends string> {
  readonly before: VersionedState<State>;
  readonly after: VersionedState<State>;
  readonly commandId: string;
  readonly actor: Actor;
  readonly correlationId: string;
}

export function recordTransition<State extends string>(
  before: VersionedState<State>,
  after: VersionedState<State>,
  command: Pick<DomainCommand<State>, 'commandId' | 'actor' | 'correlationId'>,
): DomainTransition<State> {
  if (after.version !== before.version + 1)
    throw new Error('A domain transition must advance one version');
  return Object.freeze({ before, after, ...command });
}

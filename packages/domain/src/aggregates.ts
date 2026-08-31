import { assertAcyclicDependencies } from './state-machines.js';
import type {
  PersonaIdentity,
  ProjectAggregate,
  SpecialistIdentity,
  TaskAggregate,
  TaskDependency,
} from './types.js';

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be empty`);
  return normalized;
}

export function createProject(
  input: Omit<ProjectAggregate, 'state' | 'version' | 'objective'> & { objective: string },
): ProjectAggregate {
  return Object.freeze({
    ...input,
    objective: nonEmpty(input.objective, 'objective'),
    state: 'CREATING',
    version: 1,
  });
}

export function createTask(
  input: Omit<TaskAggregate, 'state' | 'version' | 'title' | 'objective' | 'dependencies'> & {
    readonly title: string;
    readonly objective: string;
    readonly dependencies?: readonly TaskDependency[];
  },
): TaskAggregate {
  const dependencies = Object.freeze([...(input.dependencies ?? [])]);
  assertAcyclicDependencies(dependencies);
  return Object.freeze({
    ...input,
    title: nonEmpty(input.title, 'title'),
    objective: nonEmpty(input.objective, 'objective'),
    acceptanceCriteria: Object.freeze([...input.acceptanceCriteria]),
    dependencies,
    state: 'PROPOSED',
    version: 1,
  });
}

export function createPersona(input: PersonaIdentity): PersonaIdentity {
  if (input.kind !== 'PERSONA') throw new Error('Persona kind must be PERSONA');
  return Object.freeze({ ...input });
}

export function createSpecialist(input: SpecialistIdentity): SpecialistIdentity {
  if (input.kind !== 'SPECIALIST') throw new Error('Specialist kind must be SPECIALIST');
  if (input.parentPersonaId === input.agentId) throw new Error('Specialist cannot parent itself');
  if (input.archivalConditions.length === 0)
    throw new Error('Specialist archival conditions are required');
  return Object.freeze({
    ...input,
    archivalConditions: Object.freeze([...input.archivalConditions]),
  });
}

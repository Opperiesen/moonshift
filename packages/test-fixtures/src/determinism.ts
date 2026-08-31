export type DeterministicClock = {
  now(): Date;
  advance(milliseconds: number): Date;
};

export function createDeterministicClock(start: string | Date): DeterministicClock {
  let current = new Date(start).getTime();
  if (!Number.isFinite(current)) throw new RangeError('Invalid deterministic clock start');
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        throw new RangeError('Invalid duration');
      current += milliseconds;
      return new Date(current);
    },
  };
}

export function createDeterministicUuid(seed = 'moonshift-fixture'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const input = `${seed}:${counter}`;
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return `${hex}-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };
}

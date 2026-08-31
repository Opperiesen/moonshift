import { createHash } from 'node:crypto';

export type Classification = 'PUBLIC_FIXTURE' | 'INSTANCE_INTERNAL' | 'SENSITIVE_METADATA';
export type ContextSourceType =
  | 'objective'
  | 'acceptance_criteria'
  | 'task'
  | 'repository_revision'
  | 'artifact'
  | 'decision_summary'
  | 'raw_chat'
  | 'private_reasoning';
export type ContextInput = {
  sourceType: ContextSourceType;
  sourceReference: string;
  revision?: string;
  content: string;
  classification: Classification;
  inclusionReason: string;
  transformation?: string;
  artifactReference?: string;
};
export type ContextCompileInput = {
  executionId: string;
  taskId: string;
  agentId: string;
  connectionId: string;
  policyVersion: string;
  destination: 'FAKE_EXECUTION';
  tokenBudget: number;
  inputs: ContextInput[];
};
export type ContextManifestItem = Omit<ContextInput, 'content'> & {
  contentHash: `sha256:${string}`;
  tokenCount: number;
  order: number;
};
export type ContextManifest = {
  schemaVersion: '1.0';
  executionId: string;
  taskId: string;
  agentId: string;
  connectionId: string;
  compilerPolicyVersion: string;
  destination: 'FAKE_EXECUTION';
  tokenBudget: number;
  tokenCount: number;
  items: readonly ContextManifestItem[];
  manifestHash: `sha256:${string}`;
  createdAt: string;
};

const forbidden = new Set<ContextSourceType>(['raw_chat', 'private_reasoning']);
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const hash = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}` as `sha256:${string}`;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as object)) freeze(child);
  }
  return value;
};

export function compileContext(input: ContextCompileInput): ContextManifest {
  if (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 1)
    throw new Error('Invalid token budget');
  const candidates = input.inputs
    .filter((item) => item.sourceType !== 'raw_chat')
    .map((item) => {
      if (forbidden.has(item.sourceType))
        throw new Error(`Prohibited context source: ${item.sourceType}`);
      if (item.classification === 'SENSITIVE_METADATA')
        throw new Error('Classification is not permitted for FAKE_EXECUTION');
      if (!item.sourceReference || !item.inclusionReason || typeof item.content !== 'string')
        throw new Error('Incomplete context item');
      if (item.artifactReference && !/^sha256:[a-f0-9]{64}$/.test(item.artifactReference))
        throw new Error('Invalid artifact reference');
      const contentHash = hash(item.content);
      const tokenCount = Math.max(1, Math.ceil(item.content.length / 4));
      return { ...item, contentHash, tokenCount };
    })
    .sort(
      (a, b) =>
        a.sourceType.localeCompare(b.sourceType) ||
        a.sourceReference.localeCompare(b.sourceReference) ||
        a.contentHash.localeCompare(b.contentHash),
    );
  let used = 0;
  const items: ContextManifestItem[] = [];
  for (const item of candidates) {
    if (used + item.tokenCount > input.tokenBudget) continue;
    used += item.tokenCount;
    const { content: _content, ...manifestItem } = item;
    items.push({ ...manifestItem, order: items.length + 1 });
  }
  const base = {
    schemaVersion: '1.0' as const,
    executionId: input.executionId,
    taskId: input.taskId,
    agentId: input.agentId,
    connectionId: input.connectionId,
    compilerPolicyVersion: input.policyVersion,
    destination: input.destination,
    tokenBudget: input.tokenBudget,
    tokenCount: used,
    items,
    createdAt: '1970-01-01T00:00:00.000Z',
  };
  return freeze({ ...base, manifestHash: hash(canonical(base)) });
}

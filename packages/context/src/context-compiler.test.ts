import { describe, expect, it } from 'vitest';
import { compileContext } from './context-compiler.js';

describe('compileContext', () => {
  const input = {
    executionId: 'exec-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    connectionId: 'conn-1',
    policyVersion: 'policy-1',
    destination: 'FAKE_EXECUTION' as const,
    tokenBudget: 20,
    inputs: [
      {
        sourceType: 'objective' as const,
        sourceReference: 'project/objective',
        content: 'Build fixture',
        classification: 'PUBLIC_FIXTURE' as const,
        inclusionReason: 'objective',
      },
      {
        sourceType: 'artifact' as const,
        sourceReference: 'artifact/sha',
        content: 'artifact bytes',
        classification: 'INSTANCE_INTERNAL' as const,
        inclusionReason: 'required artifact',
        artifactReference: 'sha256:' + 'a'.repeat(64),
      },
      {
        sourceType: 'raw_chat' as const,
        sourceReference: 'chat/1',
        content: 'private reasoning',
        classification: 'SENSITIVE_METADATA' as const,
        inclusionReason: 'never',
      },
    ],
  };

  it('compiles explicit deterministic items and excludes raw chat/private reasoning', () => {
    const manifest = compileContext(input);
    expect(manifest.items.map((item) => item.sourceType)).toEqual(['artifact', 'objective']);
    expect(JSON.stringify(manifest)).not.toContain('private reasoning');
    expect(manifest.tokenCount).toBeLessThanOrEqual(20);
    expect(manifest.manifestHash).toMatch(/^sha256:/);
    expect(() => {
      (manifest as { destination: string }).destination = 'changed';
    }).toThrow();
    expect(compileContext(input)).toEqual(manifest);
  });

  it('fails closed for private reasoning and disallowed classifications', () => {
    const objective = input.inputs[0];
    if (objective === undefined) throw new Error('Objective fixture required');
    expect(() =>
      compileContext({
        ...input,
        inputs: [{ ...objective, sourceType: 'private_reasoning' as const }],
      }),
    ).toThrow(/prohibited/i);
    expect(() =>
      compileContext({
        ...input,
        inputs: [{ ...objective, classification: 'SENSITIVE_METADATA' as const }],
      }),
    ).toThrow(/classification/i);
  });
});

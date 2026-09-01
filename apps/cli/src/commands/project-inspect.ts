import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { planningValidators } from '@moonshift/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ResultReadContract {
  readonly projectId: string;
  readonly projectState: string;
  readonly task: {
    readonly taskId: string;
    readonly state: string;
    readonly expectedRevision: string;
  };
  readonly artifacts: readonly unknown[];
  readonly evidence: readonly unknown[];
  readonly approvals: readonly unknown[];
  readonly executions: readonly {
    readonly executionId: string;
    readonly state: string;
    readonly attemptNumber: number;
    readonly backendConnectionId: string;
    readonly modelDescriptorId: string;
    readonly modelDescriptorVersion: number;
  }[];
  readonly checkpoints: readonly unknown[];
  readonly effects: readonly unknown[];
  readonly blockedReasons: readonly string[];
  readonly recovery: {
    readonly state: string;
    readonly progress: string;
  };
  readonly audit: readonly unknown[];
  readonly verified: boolean;
}

export interface ProjectInspectDependencies {
  readonly fetch?: typeof fetch;
  readonly sessionCookie?: string;
  readonly exportFile?: (path: string, contents: string) => Promise<void>;
}

interface ProjectInspectOptions {
  readonly projectId: string;
  readonly baseUrl: URL;
  readonly format: 'summary' | 'json';
  readonly outputPath: string | null;
}

function parseOptions(args: readonly string[]): ProjectInspectOptions {
  const projectId = args[0];
  if (projectId === undefined || !UUID.test(projectId))
    throw new Error('A valid project ID is required.');
  let baseUrl: URL | undefined;
  let format: ProjectInspectOptions['format'] = 'summary';
  let outputPath: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === '--base-url' && value !== undefined) {
      baseUrl = new URL(value);
      index += 1;
      continue;
    }
    if (option === '--format' && (value === 'summary' || value === 'json')) {
      format = value;
      index += 1;
      continue;
    }
    if (option === '--output' && value !== undefined) {
      outputPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete project inspect option: ${option ?? ''}`);
  }
  if (baseUrl === undefined) throw new Error('--base-url is required.');
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('The control-plane URL must use HTTP or HTTPS.');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(baseUrl.hostname)) {
    throw new Error('The slice 001 inspection endpoint must be loopback-only.');
  }
  return Object.freeze({ projectId, baseUrl, format, outputPath });
}

function resultContract(value: unknown, expectedProjectId: string): ResultReadContract {
  planningValidators().resultView.assert(value);
  const result = value as ResultReadContract;
  if (result.projectId !== expectedProjectId) {
    throw new Error('Results response project identity does not match the inspection target.');
  }
  return result;
}

function summary(result: ResultReadContract): string {
  const current = result.executions[0];
  const lines = [
    `Project ${result.projectId}: ${result.projectState}`,
    `Task ${result.task.taskId}: ${result.task.state}`,
    `Verified: ${result.verified ? 'yes' : 'no'}`,
    `Expected revision: ${result.task.expectedRevision}`,
    `Recovery: ${result.recovery.state} · ${result.recovery.progress}`,
    `Records: ${result.artifacts.length} artifacts, ${result.evidence.length} evidence, ${result.approvals.length} approvals, ${result.executions.length} executions, ${result.checkpoints.length} checkpoints, ${result.effects.length} effects, ${result.audit.length} audit events`,
  ];
  for (const reason of result.blockedReasons) lines.push(`Blocked: ${reason}`);
  if (current !== undefined) {
    lines.push(
      `Current execution ${current.executionId}: ${current.state} (attempt ${current.attemptNumber}, connection ${current.backendConnectionId}, model ${current.modelDescriptorId} v${current.modelDescriptorVersion})`,
    );
  }
  return lines.join('\n');
}

async function defaultExport(path: string, contents: string): Promise<void> {
  await writeFile(resolve(path), contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export async function runProjectInspect(
  args: readonly string[],
  dependencies: ProjectInspectDependencies = {},
): Promise<string | null> {
  const options = parseOptions(args);
  const sessionCookie = dependencies.sessionCookie;
  if (sessionCookie === undefined || sessionCookie.trim().length === 0) {
    throw new Error('MOONSHIFT_SESSION_COOKIE is required for supervisor inspection.');
  }
  const endpoint = new URL(
    `/v1/projects/${encodeURIComponent(options.projectId)}/results`,
    options.baseUrl,
  );
  const response = await (dependencies.fetch ?? globalThis.fetch)(endpoint, {
    headers: { accept: 'application/json', cookie: sessionCookie },
  });
  if (!response.ok) throw new Error(`Project inspection failed with HTTP ${response.status}.`);
  const result = resultContract(await response.json(), options.projectId);
  const rendered = options.format === 'json' ? JSON.stringify(result, null, 2) : summary(result);
  if (options.outputPath === null) return rendered;
  await (dependencies.exportFile ?? defaultExport)(options.outputPath, `${rendered}\n`);
  return null;
}

#!/usr/bin/env node

import { runProjectInspect } from './commands/project-inspect.js';

async function main(): Promise<void> {
  const [resource, command, ...args] = process.argv.slice(2);
  if (resource !== 'project' || command !== 'inspect') {
    throw new Error(
      'Usage: moonshift project inspect <project-id> --base-url <loopback-url> [--format summary|json] [--output <path>]',
    );
  }
  const sessionCookie = process.env.MOONSHIFT_SESSION_COOKIE;
  const output = await runProjectInspect(args, {
    ...(sessionCookie === undefined ? {} : { sessionCookie }),
  });
  if (output !== null) process.stdout.write(`${output}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Project inspection failed'}\n`);
  process.exitCode = 1;
});

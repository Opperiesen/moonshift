import { execFileSync } from 'node:child_process';

const commands = [
  ['pnpm', ['format:check']],
  ['pnpm', ['lint']],
  ['pnpm', ['lockfile:check']],
  ['pnpm', ['compose:check']],
  ['node', ['scripts/check-secrets.mjs']],
  ['pnpm', ['typecheck']],
  ['pnpm', ['test:unit']],
  ['pnpm', ['test:contract']],
  ['pnpm', ['test:integration']],
];
for (const [command, args] of commands) execFileSync(command, args, { stdio: 'inherit' });
console.log('validation complete; browser artifacts are written under test-results/');

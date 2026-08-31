import { readFile } from 'node:fs/promises';

const lockfile = await readFile('pnpm-lock.yaml', 'utf8');
if (!lockfile.includes('lockfileVersion:'))
  throw new Error('pnpm lockfile is missing lockfileVersion');
if (!lockfile.includes('typescript@7.0.2'))
  throw new Error('lockfile does not pin TypeScript 7.0.2');
console.log('lockfile integrity: metadata present and toolchain pin found');

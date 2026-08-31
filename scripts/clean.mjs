import { readdir, rm } from 'node:fs/promises';

for (const root of ['apps', 'packages']) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory())
      await rm(`${root}/${entry.name}/dist`, { recursive: true, force: true });
  }
}
for (const path of ['build', 'coverage', 'playwright-report', 'test-results']) {
  await rm(path, { recursive: true, force: true });
}

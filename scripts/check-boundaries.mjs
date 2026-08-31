import { readFile, readdir } from 'node:fs/promises';

const roots = ['packages'];
const forbidden = /from\s+['"](?:\.\.\/)+(?:apps|packages\/(?:persistence|backend-fake))/;
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist')
      await visit(path);
    if (
      entry.isFile() &&
      /\.(?:ts|tsx|js|mjs)$/.test(entry.name) &&
      forbidden.test(await readFile(path, 'utf8'))
    )
      throw new Error(`forbidden dependency boundary import: ${path}`);
  }
}
for (const root of roots) await visit(root);

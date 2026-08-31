import { readFile } from 'node:fs/promises';

const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
const images = [...compose.matchAll(/^\s*image:\s*([^\s#]+)\s*(?:#.*)?$/gmu)].map(
  ([, image]) => image,
);
if (images.length === 0) throw new Error('compose image pin check found no images');
for (const image of images) {
  if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
    throw new Error(`compose image is not pinned by immutable digest: ${image}`);
  }
}
console.log(`compose image pins: ${images.length} immutable digest(s)`);

import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const configurationUrl = new URL('../config/validation/secret-patterns.json', import.meta.url);
const configuration = JSON.parse(await readFile(configurationUrl, 'utf8'));
if (
  configuration === null ||
  typeof configuration !== 'object' ||
  !Array.isArray(configuration.patterns) ||
  !configuration.patterns.every((pattern) => typeof pattern === 'string')
) {
  throw new Error('invalid secret scan configuration');
}
const secretPatterns = configuration.patterns.map((pattern) => new RegExp(pattern, 'imu'));
const ignored = /^(?:\.git|node_modules|dist|coverage|test-results|playwright-report)(?:\/|$)/;

function decodedRepresentations(bytes) {
  const evenLength = bytes.byteLength - (bytes.byteLength % 2);
  const bigEndianAsLittleEndian = Buffer.allocUnsafe(evenLength);
  for (let offset = 0; offset < evenLength; offset += 2) {
    bigEndianAsLittleEndian[offset] = bytes[offset + 1];
    bigEndianAsLittleEndian[offset + 1] = bytes[offset];
  }
  return [
    bytes.toString('utf8'),
    bytes.subarray(0, evenLength).toString('utf16le'),
    bigEndianAsLittleEndian.toString('utf16le'),
  ];
}

async function scan(directory, root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    const normalized = relative(root, path).split(sep).join('/');
    if (ignored.test(normalized)) continue;
    if (entry.isDirectory()) await scan(path, root);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      if (
        decodedRepresentations(bytes).some((content) =>
          secretPatterns.some((pattern) => pattern.test(content)),
        )
      ) {
        throw new Error(`credential-like material found in ${normalized}`);
      }
    }
  }
}
const root = resolve(process.argv[2] ?? '.');
await scan(root, root);
console.log('secret scan: no credential-like material found');

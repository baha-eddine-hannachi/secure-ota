import { createPublicKey } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function option(name) {
  const value = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

const publicPemPath = path.resolve(option('pub'));
const outputPath = path.resolve(option('out'));
const spki = createPublicKey(await readFile(publicPemPath)).export({ type: 'spki', format: 'der' });
if (spki.length !== 91) throw new Error('Expected a 91-byte P-256 SPKI public key');
const point = spki.subarray(-65);
if (point.length !== 65 || point[0] !== 0x04) throw new Error('Expected an uncompressed P-256 public point');
const bytes = [...point].map((byte) => `0x${byte.toString(16).padStart(2, '0')}`);
const header = `#include <stdint.h>\n\nstatic const uint8_t SIGNING_PUBKEY[65] = {\n    ${bytes.join(', ')}\n};\n`;
await writeFile(outputPath, header, { flag: 'w', mode: 0o600 });
process.stdout.write(`Wrote public key header to ${outputPath}\n`);

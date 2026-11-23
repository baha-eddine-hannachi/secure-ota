import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Run locally when authorized: this script never prints key bytes. The generated
// header is ignored by Git and deliberately absent from the repository.
const keyPath = path.resolve(process.argv[2] ?? path.join(os.homedir(), '.iot-keys', 'fw-aes.key'));
const outPath = path.resolve(process.argv[3] ?? fileURLToPath(new URL('../main/fw_key.h', import.meta.url)));
const key = await readFile(keyPath);
if (key.length !== 32) throw new Error('AES-256 key must be exactly 32 raw bytes');
const bytes = [...key].map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ');
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `#pragma once\n#include <stdint.h>\nstatic const uint8_t FW_AES_KEY[32] = { ${bytes} };\n`, { mode: 0o600, flag: 'w' });
key.fill(0);
process.stdout.write('Generated ignored firmware AES header.\n');

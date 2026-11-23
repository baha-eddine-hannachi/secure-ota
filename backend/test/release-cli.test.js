import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

test('release CLI dry-run prechecks and signs with an isolated temporary key without backend contact', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-release-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPath = path.join(dir, 'temporary-private.pem'); await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const image = Buffer.alloc(512); image[0] = 0xe9; image.writeUInt32LE(0xabcd5432, 32); image.write('1.8.6\0', 48, 'utf8'); image.write('wifi_base\0', 80, 'utf8');
  const firmwarePath = path.join(dir, 'wifi_base.bin'); await writeFile(firmwarePath, image);
  const run = spawnSync(process.execPath, ['scripts/release.js', '--version', '1.8.6', '--min-version', '1.8.5', '--firmware', firmwarePath, '--key', keyPath, '--dry-run'], { cwd: path.resolve(dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8', env: { ...process.env, FIRMWARE_BASE_URL: 'https://mock.invalid:8443' } });
  assert.equal(run.status, 0, run.stderr);
  process.stdout.write(run.stdout);
  assert.match(run.stdout, /Using backend: https:\/\/mock\.invalid:8443/);
  assert.match(run.stdout, /DRY RUN PASS/);
  assert.match(run.stdout, /no backend contacted, no release registered, no OTA sent/);
});

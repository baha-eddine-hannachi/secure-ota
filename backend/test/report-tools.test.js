import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(backend, 'scripts');
const run = (script, args, reports) => spawnSync(process.execPath, [path.join(scripts, script), ...args], { cwd: backend, encoding: 'utf8', env: { ...process.env, OTA_REPORTS_DIR: reports } });

test('report seed creates T01 as reported PASS and all other cases NOT_RUN', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-report-seed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reports = path.join(dir, 'reports');
  const seeded = run('seed_test_results.js', [], reports);
  assert.equal(seeded.status, 0, seeded.stderr);
  const t01 = JSON.parse(await readFile(path.join(reports, 'results', 'T01.json'), 'utf8'));
  assert.equal(t01.status, 'PASS');
  assert.match(t01.notes, /pas été vérifié indépendamment/);
  for (let n = 2; n <= 14; n++) {
    const id = `T${String(n).padStart(2, '0')}`;
    assert.equal(JSON.parse(await readFile(path.join(reports, 'results', `${id}.json`), 'utf8')).status, 'NOT_RUN');
  }
});

test('evidence ingestion masks credential lines, PEM and key-like material; refuses binary/protected paths', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-report-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reports = path.join(dir, 'reports');
  await mkdir(reports, { recursive: true });
  const source = path.join(dir, 'console.txt');
  await writeFile(source, 'password=hunter2\nAuthorization: Bearer secret-bearer\nWIFI_PASS=wifi-secret\nkey: 0123456789abcdef0123456789abcdef\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----\nOK\n');
  const result = run('add_test_result.js', ['--id=T02', '--status=FAIL', '--fw-from=1.2.0', '--fw-to=1.3.0', '--summary=Échec de test', `--evidence=${source}`], reports);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /masqué/);
  const saved = await readFile(path.join(reports, 'evidence', 'T02-1.txt'), 'utf8');
  for (const secret of ['hunter2', 'secret-bearer', 'wifi-secret', '0123456789abcdef0123456789abcdef', 'private-material']) assert.equal(saved.includes(secret), false);
  assert.match(saved, /REDACTED/);

  const binary = path.join(dir, 'binary.log'); await writeFile(binary, Buffer.from([0x42, 0xff, 0x00]));
  const rejectedBinary = run('add_test_result.js', ['--id=T03', '--status=FAIL', '--summary=binaire', `--evidence=${binary}`], reports);
  assert.notEqual(rejectedBinary.status, 0);
  const envFile = path.join(dir, '.env'); await writeFile(envFile, 'do-not-read');
  const rejectedEnv = run('add_test_result.js', ['--id=T03', '--status=FAIL', '--summary=env', `--evidence=${envFile}`], reports);
  assert.notEqual(rejectedEnv.status, 0);
});

test('report generator creates per-test procedures and escapes untrusted HTML values', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-report-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reports = path.join(dir, 'reports');
  const seeded = run('seed_test_results.js', [], reports);
  assert.equal(seeded.status, 0, seeded.stderr);
  const updated = run('add_test_result.js', ['--id=T02', '--status=NOT_RUN', '--summary=<script>alert(1)</script>'], reports);
  assert.equal(updated.status, 0, updated.stderr);
  const built = run('build_report.js', [], reports);
  assert.equal(built.status, 0, built.stderr);
  const markdown = await readFile(path.join(reports, 'OTA_TEST_REPORT.md'), 'utf8');
  const html = await readFile(path.join(reports, 'OTA_TEST_REPORT.html'), 'utf8');
  assert.match(markdown, /## T14/);
  assert.match(html, /@page\{size:A4/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal((await readFile(path.join(reports, 'tests', 'T02.md'), 'utf8')).includes('Étape'), true);
});

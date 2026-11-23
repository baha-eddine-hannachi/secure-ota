import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createApp } from '../src/http/app.js';
import { createTestResultsService } from '../src/services/testResults.js';

const token = 'a'.repeat(40);
const resultRecord = (id, status = 'NOT_RUN', evidence = []) => ({ id, title: `Test ${id}`, stage: 'backend', status, fw_from: '', fw_to: '', date: '2026-11-11T12:00:00.000Z', operator: 'test-runner', summary: 'Résultat de test', observed: [], evidence, notes: '' });

async function appFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-dashboard-'));
  const reports = path.join(dir, 'reports');
  await mkdir(path.join(reports, 'results'), { recursive: true });
  await mkdir(path.join(reports, 'evidence'), { recursive: true });
  await writeFile(path.join(reports, 'results', 'T01.json'), JSON.stringify(resultRecord('T01', 'PASS', ['T01-1.txt'])));
  await writeFile(path.join(reports, 'evidence', 'T01-1.txt'), 'preuve masquée');
  await writeFile(path.join(reports, 'OTA_TEST_REPORT.html'), '<!doctype html><html lang="fr"><title>Rapport</title></html>');
  const testResults = createTestResultsService(reports);
  const updates = [
    { request_id: 'older', device_id: 'esp32-001', version: '1.2.0', state: 'success', created_at: '2026-11-10T10:00:00.000Z', updated_at: '2026-11-10T10:01:00.000Z', error_code: null, history: [{ state: 'sent' }, { state: 'success' }] },
    { request_id: 'newer', device_id: 'esp32-002', version: '1.3.0', state: 'failed', created_at: '2026-11-11T10:00:00.000Z', updated_at: '2026-11-11T10:02:00.000Z', error_code: 'download_failed', history: [{ state: 'sent' }, { state: 'failed', error_code: 'download_failed' }] },
  ];
  const services = {
    events: { async record() {}, list: () => [{ id: 'ev1', type: 'auth_failure', device_id: null, severity: 'warning', timestamp: '2026-11-11T11:00:00.000Z', details: {} }] },
    devices: { list: () => [{ device_id: 'esp32-001', target: 'esp32', version: '1.2.0', online: true, last_seen: '2026-11-11T11:00:00.000Z', uptime_s: 30 }], get: () => null },
    firmwares: { list: () => [{ id: 'esp32:1.3.0', device_type: 'esp32', version: '1.3.0', size: 128, sha256: 'f'.repeat(64), registered_at: '2026-11-11T09:00:00.000Z', signature_alg: 'ECDSA-P256-SHA256-P1363', encrypted: false }], async scanReleases() { return [{ version: '1.4.0', result: 'registered' }]; } },
    updates: { list: () => updates, get: async (id) => updates.find((item) => item.request_id === id) ?? null, async expireDue() {} },
    testResults,
  };
  const config = { adminApiToken: token, firmwareDir: path.join(dir, 'firmware'), deviceId: 'esp32-001' };
  const server = createServer(createApp({ config, services, mqtt: { connected: true }, logger: { error() {} } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, auth = true) => fetch(`${base}${url}`, auth ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { base, get, updates };
}

test('dashboard shell is public with a self-only CSP and external assets', async (t) => {
  const f = await appFixture(t);
  const response = await fetch(`${f.base}/dashboard/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /style-src 'self'/);
  assert.match(html, /dashboard\.js/);
  assert.match(html, /dashboard\.css/);
  assert.doesNotMatch(html, /<script\s*>/i);
});

test('dashboard tab panels respect the hidden attribute', async () => {
  const css = await readFile(new URL('../public/dashboard.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  assert.match(css, /\.view\[hidden\]\s*\{\s*display\s*:\s*none\s*;?\s*\}/);
  assert.match(js, /view\.hidden\s*=\s*view\.id\s*!==\s*tab\.getAttribute\('aria-controls'\)/);
});

test('overview and update list require auth and return bounded projections', async (t) => {
  const f = await appFixture(t);
  assert.equal((await f.get('/api/overview', false)).status, 401);
  const overview = await (await f.get('/api/overview')).json();
  assert.equal(overview.broker_connected, true);
  assert.equal(overview.counts.active_updates, 0);
  assert.equal(overview.firmwares[0].sha256, 'f'.repeat(64));
  const updates = await (await f.get('/api/updates?device_id=esp32-002&state=failed&limit=1')).json();
  assert.equal(updates.updates.length, 1);
  assert.equal(updates.updates[0].error_code, 'download_failed');
  assert.equal(updates.updates[0].history_length, 2);
  assert.equal((await f.get('/api/updates?limit=101')).status, 400);
  assert.equal((await f.get('/api/updates?unknown=x')).status, 400);
});

test('release scan requires admin authentication and returns per-release results', async (t) => {
  const f = await appFixture(t);
  assert.equal((await fetch(`${f.base}/api/releases/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const response = await fetch(`${f.base}/api/releases/scan`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results, [{ version: '1.4.0', result: 'registered' }]);
});

test('overview and update list expose live progress and current or last error code safely', async (t) => {
  const f = await appFixture(t);
  f.updates.unshift({
    request_id: 'active', device_id: 'esp32-001', version: '1.3.0', state: 'downloading', progress: 42,
    created_at: '2026-11-11T12:00:00.000Z', updated_at: '2026-11-11T12:00:10.000Z', error_code: null,
    history: [{ state: 'sent' }, { state: 'received' }, { state: 'downloading', progress: 42 }],
  });
  const overview = await (await f.get('/api/overview')).json();
  assert.equal(overview.active_updates[0].state, 'downloading');
  assert.equal(overview.active_updates[0].progress, 42);
  assert.equal(overview.active_updates[0].error_code, null);
  const list = await (await f.get('/api/updates')).json();
  assert.equal(list.updates[0].progress, 42);
  assert.equal(list.updates[1].error_code, 'download_failed');
  const js = await readFile(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  assert.match(js, /node\.textContent\s*=\s*String\(text\)/);
  assert.match(js, /progress\.value\s*=\s*update\.progress/);
  assert.match(js, /Erreur : \$\{update\.error_code/);
  assert.match(js, /Dernière mise à jour : \$\{latest\.device_id/);
});

test('test result endpoints return counts, safe evidence, and reject invalid or traversing ids', async (t) => {
  const f = await appFixture(t);
  assert.equal((await f.get('/api/test-results', false)).status, 401);
  const list = await (await f.get('/api/test-results')).json();
  assert.equal(list.counts.PASS, 1);
  assert.equal(list.results[0].id, 'T01');
  const detail = await (await f.get('/api/test-results/T01')).json();
  assert.equal(detail.result.evidence[0].text, 'preuve masquée');
  assert.equal((await f.get('/api/test-results/nope')).status, 400);
  assert.equal((await f.get('/api/test-results/T14')).status, 404);
  const traversal = await f.get('/api/test-results/T01%2F..%2Fsecret');
  assert.ok([400, 404].includes(traversal.status));
  assert.equal(traversal.status >= 500, false);
  assert.equal((await fetch(`${f.base}/api/test-results/T01`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 404);
});

test('printable report endpoint is protected and returns generated HTML', async (t) => {
  const f = await appFixture(t);
  assert.equal((await f.get('/api/test-report.html', false)).status, 401);
  const response = await f.get('/api/test-report.html');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Rapport/);
  assert.match(response.headers.get('content-security-policy'), /style-src 'unsafe-inline'/);
});

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { JsonStore } from '../src/store/jsonStore.js';
import { createEventsService } from '../src/services/events.js';
import { createDevicesService } from '../src/services/devices.js';
import { createFirmwaresService } from '../src/services/firmwares.js';
import { createUpdatesService } from '../src/services/updates.js';
import { createApp } from '../src/http/app.js';
import { statusSchema } from '../src/mqtt/schemas.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-qa-'));
const results = [];
const record = (id, result, detail) => { results.push({ id, result, detail }); console.log(`${id}\t${result}\t${detail}`); };
let now = Date.now();
try {
  const store = await new JsonStore(path.join(dir, 'state.json')).init();
  const events = createEventsService(store);
  const devices = createDevicesService(store);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubFile = path.join(dir, 'test-public.pem');
  await writeFile(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
  const firmwareDir = path.join(dir, 'firmware');
  const firmwareSourceDir = path.join(dir, 'release'); await mkdir(firmwareSourceDir);
  const firmwares = createFirmwaresService({ store, firmwareDir, firmwareSourceDir, firmwareBaseUrl: 'https://qa.invalid', publicKeyPath: pubFile, events });
  const calls = [];
  const mqtt = { connected: true, async publishCommand(command) { calls.push(command); } };
  const updates = createUpdatesService({ store, mqtt, devices, firmwares, events, ttlSeconds: 30, now: () => now });

  async function register({ version = '1.2.0', min = '1.0.0', bytes = Buffer.from('qa firmware') } = {}) {
    const file = path.join(firmwareSourceDir, `input-${Math.random().toString(16).slice(2)}.bin`);
    await writeFile(file, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const message = `IOTFW1|esp32|${version}|${min}|${bytes.length}|${sha256}|0`;
    const signature = sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const manifest = { device_type: 'esp32', version, min_version: min, size: bytes.length, sha256, signature, signature_alg: 'ECDSA-P256-SHA256-P1363', encrypted: false, url: 'https://qa.invalid/source', issued_at: new Date().toISOString() };
    return firmwares.register({ manifest, firmwarePath: file });
  }

  // Auth, generic responses, and security headers use an isolated in-memory HTTP listener.
  const config = { adminApiToken: 'T'.repeat(48), firmwareDir };
  const app = createApp({ config, services: { events, devices, firmwares, updates }, mqtt, logger: { error() {} } });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    const h = await health.json();
    assert.equal(health.status, 200); assert.deepEqual(h, { status: 'ok', mqtt_connected: true });
    record('A2', 'PASS', 'isolated GET /api/health returns status and MQTT state only');
    const authCases = [
      ['no token', {}], ['wrong token', { authorization: 'Bearer wrong' }],
      ['malformed header', { authorization: 'Basic abc' }], ['empty bearer', { authorization: 'Bearer ' }],
    ];
    for (const [label, headers] of authCases) {
      const response = await fetch(`${base}/api/devices`, { headers });
      const body = await response.json();
      assert.equal(response.status, 401); assert.deepEqual(body, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      record(`A1-${label}`, 'PASS', '401 generic JSON; no data returned');
    }
    const queryToken = await fetch(`${base}/api/devices?token=${config.adminApiToken}`);
    assert.equal(queryToken.status, 401); record('A1-query-token', 'PASS', 'query token does not authenticate');
    assert.equal(events.list().filter((e) => e.type === 'auth_failure').length, 5);
    assert.equal(JSON.stringify(events.list()).includes(config.adminApiToken), false);
    record('A1-event', 'PASS', 'five auth failures recorded without token in event data');
    const headersResponse = await fetch(`${base}/api/health`);
    assert.equal(headersResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(headersResponse.headers.get('strict-transport-security'));
    assert.equal(headersResponse.headers.get('x-powered-by'), null);
    assert.notEqual(headersResponse.headers.get('access-control-allow-origin'), '*');
    const authenticatedHeaders = await fetch(`${base}/api/devices`, { headers: { authorization: `Bearer ${config.adminApiToken}` } });
    assert.equal(authenticatedHeaders.status, 200);
    assert.notEqual(authenticatedHeaders.headers.get('access-control-allow-origin'), '*');
    record('A4', 'PASS', 'Helmet headers present; X-Powered-By absent; no wildcard CORS');
    const malformed = await fetch(`${base}/api/updates`, { method: 'POST', headers: { authorization: `Bearer ${config.adminApiToken}`, 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400); const malformedBody = await malformed.json(); assert.ok(malformedBody.error); assert.equal(JSON.stringify(malformedBody).includes('stack'), false);
    record('B2-invalid-json', 'PASS', '400 structured error; no stack');
    const tooLarge = await fetch(`${base}/api/updates`, { method: 'POST', headers: { authorization: `Bearer ${config.adminApiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(40_000) }) });
    assert.equal(tooLarge.status, 413); record('B2-oversize', 'PASS', 'body over 32 KB receives 413');
    const badUpdate = await fetch(`${base}/api/updates`, { method: 'POST', headers: { authorization: `Bearer ${config.adminApiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ device_id: 'esp32-001', version: '1.0.0', unexpected: true }) });
    assert.equal(badUpdate.status, 400); record('B1-extra-field', 'PASS', 'strict update body rejects extra field');
    for (const id of ['not-a-uuid', '%27%20OR%201%3D1--', '%7B%22%24ne%22%3Anull%7D']) {
      const response = await fetch(`${base}/api/updates/${id}`, { headers: { authorization: `Bearer ${config.adminApiToken}` } });
      assert.equal(response.status, 404, id);
    }
    record('B3', 'PASS', 'malformed and injection-shaped update IDs return 404, not 500');
  } finally { await new Promise((resolve) => server.close(resolve)); }

  // Signature and registration checks use a newly generated, temporary key pair.
  await devices.updateStatus({ device_id: 'esp32-001', target: 'esp32', version: '1.0.0', state: 'online', min_allowed_version: '1.0.0' });
  const initial = await register();
  const initialBytes = await readFile(initial.firmware_path);
  assert.equal(createHash('sha256').update(initialBytes).digest('hex'), initial.sha256);
  record('C1', 'PASS', 'temporary-key-signed manifest accepted; stored file hash matches');
  await devices.updateStatus({ device_id: 'esp32-e1', target: 'esp32', version: '1.0.0', state: 'online' });
  await register({ version: '1.0.0', min: '0.1.0' });
  await register({ version: '0.9.0', min: '0.1.0' });
  for (const version of ['1.0.0', '0.9.0']) {
    try {
      await updates.request({ device_id: 'esp32-e1', version });
      record(`E1-${version}`, 'FAIL', `device at 1.0.0 accepted request for ${version}`);
    } catch (error) {
      assert.equal(error.code, 'VERSION_NOT_NEWER'); assert.equal(error.status, 409);
      record(`E1-${version}`, 'PASS', `device at 1.0.0 rejected request for ${version} with VERSION_NOT_NEWER`);
    }
  }
  assert.ok(events.list().some((event) => event.type === 'version_not_newer_refused' && event.severity === 'warning'));
  const newer = await updates.request({ device_id: 'esp32-e1', version: '1.2.0' });
  assert.equal(newer.state, 'sent'); record('E1-newer', 'PASS', 'newer version accepted');
  try {
    await register({ version: '1.0.0', min: '1.1.0' });
    record('C7-min-greater', 'FAIL', 'registration accepted min_version 1.1.0 above version 1.0.0');
  } catch (error) { assert.equal(error.code, 'INVALID_MANIFEST'); assert.equal(error.status, 400); record('C7-min-greater', 'PASS', 'registration rejects min_version above version with INVALID_MANIFEST'); }
  const equalFloor = await register({ version: '1.4.0', min: '1.4.0' });
  assert.equal(equalFloor.min_version, equalFloor.version); record('C7-equal', 'PASS', 'equal min_version and version accepted');
  const sameDigest = await register({ version: initial.version, bytes: initialBytes });
  assert.deepEqual(sameDigest, initial); record('C6-same-digest', 'PASS', 'same digest registration is idempotent');
  const replacementBytes = Buffer.from('different bytes');
  try {
    await register({ version: initial.version, bytes: replacementBytes });
    record('C6-different-digest', 'FAIL', 'different binary replaced existing release');
  } catch (error) {
    assert.equal(error.code, 'FIRMWARE_VERSION_EXISTS'); assert.equal(error.status, 409);
    assert.deepEqual(await readFile(initial.firmware_path), initialBytes);
    assert.ok(events.list().some((event) => event.type === 'firmware_release_replace_attempt' && event.severity === 'warning'));
    record('C6-different-digest', 'PASS', 'replacement rejected and stored bytes unchanged');
  }
  const c5bytes = Buffer.from('qa path boundary');
  const c5sha = createHash('sha256').update(c5bytes).digest('hex');
  const c5signature = sign('sha256', Buffer.from(`IOTFW1|esp32|1.3.0|1.0.0|${c5bytes.length}|${c5sha}|0`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  const c5manifest = { device_type: 'esp32', version: '1.3.0', min_version: '1.0.0', size: c5bytes.length, sha256: c5sha, signature: c5signature, signature_alg: 'ECDSA-P256-SHA256-P1363', encrypted: false, url: 'https://qa.invalid/source', issued_at: new Date().toISOString() };
  const outside = path.join(dir, 'outside'); await mkdir(outside); const outsideFile = path.join(outside, 'firmware.bin'); await writeFile(outsideFile, c5bytes);
  const nonFile = path.join(firmwareSourceDir, 'directory'); await mkdir(nonFile);
  const junction = path.join(firmwareSourceDir, 'outside-junction'); await symlink(outside, junction, 'junction');
  const invalidPaths = [outsideFile, path.join(firmwareSourceDir, '..', 'outside', 'firmware.bin'), '\\\\host\\share\\firmware.bin', path.join(firmwareSourceDir, 'CON'), path.join(firmwareSourceDir, 'NUL'), path.join(firmwareSourceDir, 'COM1.txt'), path.join(firmwareSourceDir, 'nul\0.bin'), path.join(firmwareSourceDir, 'missing.bin'), nonFile, path.join(junction, 'firmware.bin')];
  for (const firmwarePath of invalidPaths) {
    await assert.rejects(() => firmwares.register({ manifest: c5manifest, firmwarePath }), { code: 'INVALID_FIRMWARE_PATH', status: 400 });
  }
  record('C5-path-attacks', 'PASS', 'outside, UNC, device names, NUL, directory, and junction escape rejected');
  const insidePath = path.join(firmwareSourceDir, 'inside.bin'); await writeFile(insidePath, c5bytes);
  assert.equal((await firmwares.register({ manifest: c5manifest, firmwarePath: insidePath })).version, '1.3.0');
  record('C5-valid-path', 'PASS', 'regular file within allowed source folder accepted');

  // Firmware URL behavior is checked against the isolated HTTP app, never the live device.
  const fwServer = createServer(createApp({ config: { adminApiToken: config.adminApiToken, firmwareDir }, services: { events, devices, firmwares, updates }, mqtt, logger: { error() {} } }));
  await new Promise((resolve) => fwServer.listen(0, '127.0.0.1', resolve));
  const fwBase = `http://127.0.0.1:${fwServer.address().port}`;
  try {
    const binary = await fetch(`${fwBase}/firmware/esp32/1.2.0/firmware.bin`);
    const servedBytes = Buffer.from(await binary.arrayBuffer());
    assert.equal(binary.status, 200); assert.equal(createHash('sha256').update(servedBytes).digest('hex'), initial.sha256);
    const range = await fetch(`${fwBase}/firmware/esp32/1.2.0/firmware.bin`, { headers: { Range: 'bytes=0-2' } });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 3);
    record('D1-single-range', 'PASS', 'exact binary hash and 206 range verified in isolated server');
    const multi = await fetch(`${fwBase}/firmware/esp32/1.2.0/firmware.bin`, { headers: { Range: 'bytes=0-1,3-4' } });
    assert.equal(multi.status, 416); record('D1-multirange', 'PASS', 'multi-range rejected with 416');
    const manifestRange = await fetch(`${fwBase}/firmware/esp32/1.2.0/manifest.json`, { headers: { Range: 'bytes=0-2' } });
    assert.equal(manifestRange.status, 200); assert.equal(manifestRange.headers.get('accept-ranges'), 'none');
    record('D1-manifest-range', 'PASS', 'manifest is intentionally full-response; documentation limits Range support to firmware.bin');
    const unauthBinary = await fetch(`${fwBase}/firmware/esp32/1.2.0/firmware.bin`);
    assert.equal(unauthBinary.status, 200); record('D4', 'INFO', 'firmware files are publicly downloadable without admin token');
    const listing = await fetch(`${fwBase}/firmware/`); assert.equal(listing.status, 404);
    const traversal = await fetch(`${fwBase}/firmware/esp32/../state.json`); assert.equal(traversal.status, 404);
    record('D2', 'PASS', 'directory listing denied; normalized traversal path returns 404');
  } finally { await new Promise((resolve) => fwServer.close(resolve)); }

  // Update lifecycle tests use fake time, temp JSON state, and a no-op command publisher.
  const simultaneous = await Promise.allSettled(Array.from({ length: 10 }, () => updates.request({ device_id: 'esp32-001', version: '1.2.0' })));
  const accepted = simultaneous.filter((x) => x.status === 'fulfilled').length;
  record('G1', accepted === 1 ? 'PASS' : 'FAIL', `${accepted} of 10 concurrent same-device POST-equivalent requests accepted`);
  const command = calls[0];
  assert.deepEqual(Object.keys(command).sort(), ['device_id', 'expires_at', 'issued_at', 'manifest_url', 'request_id', 'target', 'version'].sort());
  record('E4-command-fields', 'PASS', 'published command has required fields; publisher implementation specifies QoS 1 and retain false');
  const update = simultaneous.find((x) => x.status === 'fulfilled').value;
  now += 31_000;
  await updates.get(update.request_id);
  now += 120_001;
  const expired = await updates.get(update.request_id);
  assert.equal(expired.state, 'expired');
  record('E3', 'PASS', 'stale sent request lazily expires after TTL plus two-minute grace');
  assert.ok(events.list().some((e) => e.type === 'update_expired' && e.severity === 'warning'));
  const afterExpiry = await updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  assert.equal(afterExpiry.state, 'sent'); record('E2-expiry-retry', 'PASS', 'new request accepted after expiry');

  await devices.updateStatus({ device_id: 'esp32-install', target: 'esp32', version: '1.0.0', min_allowed_version: '1.0.0' });
  const installing = await updates.request({ device_id: 'esp32-install', version: '1.2.0' });
  for (const state of ['received', 'downloading', 'verifying', 'installing']) await updates.handleStatus({ request_id: installing.request_id, device_id: 'esp32-install', state, progress: 60 });
  now += 329_000;
  assert.equal((await updates.get(installing.request_id)).state, 'installing');
  now += 1_001;
  assert.equal((await updates.get(installing.request_id)).state, 'expired');
  record('E3-install-grace', 'PASS', 'installing update stays active until five-minute post-expiry grace elapses');

  // Exercise schema acceptance for every documented state and reject bad values.
  const states = ['received', 'downloading', 'verifying', 'installing', 'rebooting', 'success', 'failed', 'rolled_back', 'rejected'];
  for (const state of states) assert.equal(statusSchema.safeParse({ request_id: afterExpiry.request_id, device_id: 'esp32-001', state, progress: 0 }).success, true, state);
  assert.equal(statusSchema.safeParse({ request_id: afterExpiry.request_id, device_id: 'esp32-001', state: 'bad', progress: 0 }).success, false);
  assert.equal(statusSchema.safeParse({ request_id: afterExpiry.request_id, device_id: 'esp32-001', state: 'received', progress: 1.5 }).success, false);
  record('F1-schema', 'PASS', 'all nine allowed states and invalid state/fractional progress validated');

  console.log(`TOTAL\t${results.length}\tisolated QA assertions completed`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

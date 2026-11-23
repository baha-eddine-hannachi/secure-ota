import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile, truncate } from 'node:fs/promises';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { JsonStore } from '../src/store/jsonStore.js';
import { createEventsService } from '../src/services/events.js';
import { createDevicesService } from '../src/services/devices.js';
import { createFirmwaresService } from '../src/services/firmwares.js';
import { createUpdatesService } from '../src/services/updates.js';
import { statusSchema } from '../src/mqtt/schemas.js';
import { createApp } from '../src/http/app.js';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createMqttClient } from '../src/mqtt/client.js';
import { loadConfig } from '../src/config/env.js';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-backend-'));
  const store = await new JsonStore(path.join(dir, 'store.json')).init();
  const events = createEventsService(store); const devices = createDevicesService(store);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = path.join(dir, 'signing-public.pem'); await writeFile(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  const firmwareDir = path.join(dir, 'firmware');
  const firmwareSourceDir = path.join(dir, 'release'); await mkdir(firmwareSourceDir);
  const firmwares = createFirmwaresService({ store, firmwareDir, firmwareSourceDir, firmwareBaseUrl: 'https://127.0.0.1:8443', publicKeyPath: pub, events });
  const published = []; const mqtt = { connected: true, async publishCommand(c) { published.push(c); } };
  let clock = Date.now();
  const updates = createUpdatesService({ store, mqtt, devices, firmwares, events, ttlSeconds: 600, now: () => clock });
  async function makeManifest(version = '1.2.0', bytes = Buffer.from('firmware payload'), minVersion = '1.0.0') {
    const digest = createHash('sha256').update(bytes).digest();
    const sha256 = digest.toString('hex');
    const signedMessage = `IOTFW1|esp32|${version}|${minVersion}|${bytes.length}|${sha256}|0`;
    const signature = sign('sha256', Buffer.from(signedMessage, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    return { device_type: 'esp32', version, min_version: minVersion, size: bytes.length, sha256, signature, signature_alg: 'ECDSA-P256-SHA256-P1363', encrypted: false, url: 'https://127.0.0.1/firmware.bin', issued_at: new Date().toISOString() };
  }
  async function register(version = '1.2.0', bytes = Buffer.from('firmware payload'), minVersion = '1.0.0') {
    const firmwarePath = path.join(firmwareSourceDir, 'input.bin'); await writeFile(firmwarePath, bytes);
    const manifest = await makeManifest(version, bytes, minVersion);
    return firmwares.register({ manifest, firmwarePath });
  }
  return { dir, firmwareSourceDir, store, events, devices, firmwares, updates, mqtt, published, privateKey, register, makeManifest, now: () => clock, advance: (ms) => { clock += ms; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('T04 update command is published and tracked', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001', min_allowed_version: '1.0.0' });
  const update = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  assert.equal(update.state, 'sent'); assert.equal(f.published.length, 1); assert.equal(f.published[0].target, 'esp32'); assert.ok(update.expires_at);
});

test('T05 repeated request_id publishes only once', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const first = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0', request_id: '123e4567-e89b-42d3-a456-426614174000' });
  const second = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0', request_id: first.request_id });
  assert.equal(first.request_id, second.request_id); assert.equal(f.published.length, 1);
});

test('device status racing command publish advances sent through received to rejected', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  f.mqtt.publishCommand = async (command) => {
    const ts = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await f.updates.handleStatus({ request_id: command.request_id, device_id: command.device_id, state: 'received', progress: 0, ts });
    await f.updates.handleStatus({ request_id: command.request_id, device_id: command.device_id, state: 'rejected', progress: 0, error_code: 'untrusted_url', version: command.version, ts });
  };
  const update = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  assert.equal(update.state, 'rejected');
  assert.deepEqual(update.history.map((entry) => entry.state), ['created', 'sent', 'received', 'rejected']);
  assert.equal(update.history.at(-1).error_code, 'untrusted_url');
});

test('T06/T07 altered bytes and invalid signatures are rejected and recorded', async (t) => {
  const f = await fixture(); t.after(f.cleanup); const good = await f.register();
  const changedPath = path.join(f.firmwareSourceDir, 'changed.bin'); await writeFile(changedPath, 'altered');
  const cleanManifest = { device_type: good.device_type, version: good.version, min_version: good.min_version, size: good.size, sha256: good.sha256, signature: good.signature, signature_alg: good.signature_alg, encrypted: good.encrypted, url: 'https://127.0.0.1/fw', issued_at: good.issued_at };
  await assert.rejects(() => f.firmwares.register({ manifest: cleanManifest, firmwarePath: changedPath }));
  const invalid = { device_type: good.device_type, version: '1.3.0', min_version: good.min_version, size: good.size, sha256: good.sha256, signature: Buffer.from('invalid').toString('base64'), signature_alg: good.signature_alg, encrypted: false, url: 'https://127.0.0.1/fw', issued_at: good.issued_at };
  const originalPath = path.join(f.firmwareSourceDir, 'original.bin'); await writeFile(originalPath, 'firmware payload');
  await assert.rejects(() => f.firmwares.register({ manifest: invalid, firmwarePath: originalPath }));
  assert.ok(f.events.list().some((e) => e.type === 'firmware_hash_invalid'));
  assert.ok(f.events.list().some((e) => e.type === 'firmware_signature_rejected'));
});

test('firmware signature binds version, target, minimum, size, hash, and encryption metadata', async (t) => {
  const f = await fixture(); t.after(f.cleanup); const good = await f.register();
  const firmwarePath = path.join(f.firmwareSourceDir, 'signed-input.bin'); await writeFile(firmwarePath, 'firmware payload');
  const base = { device_type: good.device_type, version: good.version, min_version: good.min_version, size: good.size, sha256: good.sha256, signature: good.signature, signature_alg: good.signature_alg, encrypted: good.encrypted, url: 'https://127.0.0.1/fw', issued_at: good.issued_at };
  const tampered = [
    { ...base, version: '1.3.0' },
    { ...base, device_type: 'stm32' },
    { ...base, min_version: '1.0.1' },
    { ...base, size: base.size + 1 },
    { ...base, sha256: `${base.sha256[0] === '0' ? '1' : '0'}${base.sha256.slice(1)}` },
    { ...base, encrypted: true, enc: { alg: 'AES-256-GCM', iv: 'AA==', tag: 'AA==', key_id: 'k1' } },
  ];
  for (const manifest of tampered) {
    const priorEventIds = new Set(f.events.list().map((e) => e.id));
    await assert.rejects(() => f.firmwares.register({ manifest, firmwarePath }));
    const newEvents = f.events.list().filter((e) => !priorEventIds.has(e.id));
    assert.ok(newEvents.some((e) => e.type === 'firmware_signature_rejected' || e.type === 'firmware_manifest_invalid'));
  }
});

test('firmware registration rejects DER signatures and the legacy algorithm label', async (t) => {
  const f = await fixture(); t.after(f.cleanup); const good = await f.register();
  const firmwarePath = path.join(f.firmwareSourceDir, 'der-input.bin'); await writeFile(firmwarePath, 'firmware payload');
  const signedMessage = `IOTFW1|${good.device_type}|${good.version}|${good.min_version}|${good.size}|${good.sha256}|0`;
  const derSignature = sign('sha256', Buffer.from(signedMessage, 'utf8'), f.privateKey).toString('base64');
  const base = { device_type: good.device_type, version: good.version, min_version: good.min_version, size: good.size, sha256: good.sha256, signature: derSignature, signature_alg: good.signature_alg, encrypted: good.encrypted, url: 'https://127.0.0.1/fw', issued_at: good.issued_at };
  await assert.rejects(() => f.firmwares.register({ manifest: base, firmwarePath }));
  await assert.rejects(() => f.firmwares.register({ manifest: { ...base, signature_alg: 'ECDSA-P256-SHA256' }, firmwarePath }));
  assert.ok(f.events.list().some((e) => e.type === 'firmware_signature_rejected'));
  assert.ok(f.events.list().some((e) => e.type === 'firmware_manifest_invalid'));
});

test('T09 anti-rollback refusal is recorded', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register('1.2.0'); await f.devices.updateStatus({ device_id: 'esp32-001', min_allowed_version: '1.5.0' });
  await assert.rejects(() => f.updates.request({ device_id: 'esp32-001', version: '1.2.0' }), { code: 'ANTI_ROLLBACK' });
  assert.ok(f.events.list().some((e) => e.type === 'anti_rollback_refused'));
});

test('C6 same release registration is idempotent and different bytes cannot replace it', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const first = await f.register('1.2.0', Buffer.from('release A'));
  const storedBytes = await readFile(first.firmware_path);
  const idempotent = await f.register('1.2.0', Buffer.from('release A'));
  assert.deepEqual(idempotent, first);
  await assert.rejects(() => f.register('1.2.0', Buffer.from('release B')), { code: 'FIRMWARE_VERSION_EXISTS', status: 409 });
  assert.deepEqual(await readFile(first.firmware_path), storedBytes);
  assert.equal(f.store.get('firmwares', first.id).sha256, first.sha256);
  assert.ok(f.events.list().some((event) => event.type === 'firmware_release_replace_attempt' && event.severity === 'warning'));
});

test('C7 rejects a minimum above the release version and accepts equality', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(() => f.register('1.0.0', Buffer.from('floor bad'), '1.0.1'), { code: 'INVALID_MANIFEST', status: 400 });
  assert.ok(f.events.list().some((event) => event.type === 'firmware_manifest_invalid' && event.details.reason === 'minimum_version_exceeds_version'));
  const equal = await f.register('1.0.0', Buffer.from('floor equal'), '1.0.0');
  assert.equal(equal.version, equal.min_version);
});

test('E1 rejects same and older update versions, but accepts a newer version', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await f.register('0.9.0', Buffer.from('older'), '0.1.0');
  await f.register('1.0.0', Buffer.from('same'), '0.1.0');
  await f.register('1.1.0', Buffer.from('newer'), '0.1.0');
  await f.devices.updateStatus({ device_id: 'esp32-001', version: '1.0.0' });
  await assert.rejects(() => f.updates.request({ device_id: 'esp32-001', version: '1.0.0' }), { code: 'VERSION_NOT_NEWER', status: 409 });
  await assert.rejects(() => f.updates.request({ device_id: 'esp32-001', version: '0.9.0' }), { code: 'VERSION_NOT_NEWER', status: 409 });
  assert.ok(f.events.list().filter((event) => event.type === 'version_not_newer_refused').length === 2);
  assert.equal((await f.updates.request({ device_id: 'esp32-001', version: '1.1.0' })).state, 'sent');
});

test('C5 firmware source paths reject escapes, UNC, device names, NUL, directories, and junction escapes', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const bytes = Buffer.from('path boundary firmware');
  const manifest = await f.makeManifest('1.2.0', bytes);
  const outsideDir = path.join(f.dir, 'outside'); await mkdir(outsideDir);
  const outsideFile = path.join(outsideDir, 'firmware.bin'); await writeFile(outsideFile, bytes);
  const sourceDirPath = path.join(f.firmwareSourceDir, 'directory'); await mkdir(sourceDirPath);
  const junction = path.join(f.firmwareSourceDir, 'external-junction');
  await symlink(outsideDir, junction, 'junction');
  const invalidPaths = [
    outsideFile,
    path.join(f.firmwareSourceDir, '..', 'outside', 'firmware.bin'),
    '\\\\server\\share\\firmware.bin',
    path.join(f.firmwareSourceDir, 'CON'),
    path.join(f.firmwareSourceDir, 'NUL'),
    path.join(f.firmwareSourceDir, 'COM1.txt'),
    path.join(f.firmwareSourceDir, 'bad\0name.bin'),
    path.join(f.firmwareSourceDir, 'missing.bin'),
    sourceDirPath,
    path.join(junction, 'firmware.bin'),
  ];
  for (const firmwarePath of invalidPaths) {
    await assert.rejects(() => f.firmwares.register({ manifest, firmwarePath }), (error) => {
      assert.equal(error.code, 'INVALID_FIRMWARE_PATH');
      assert.equal(error.status, 400);
      assert.equal(error.message.includes(firmwarePath), false);
      return true;
    });
  }
  const validFile = path.join(f.firmwareSourceDir, 'valid.bin'); await writeFile(validFile, bytes);
  const valid = await f.firmwares.register({ manifest, firmwarePath: validFile });
  assert.equal(valid.sha256, manifest.sha256);
});

test('C5 firmware registration API returns path error without echoing the submitted path', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const bytes = Buffer.from('outside source test');
  const manifest = await f.makeManifest('1.2.0', bytes);
  const outsidePath = path.join(f.dir, 'outside-secret-name.bin'); await writeFile(outsidePath, bytes);
  const config = { adminApiToken: 'a'.repeat(40), firmwareDir: path.join(f.dir, 'firmware') };
  const services = { events: f.events, devices: f.devices, firmwares: f.firmwares, updates: f.updates };
  const server = createServer(createApp({ config, services, mqtt: { connected: false }, logger: { error() {} } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/firmwares`, {
    method: 'POST', headers: { authorization: `Bearer ${config.adminApiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ manifest, firmware_path: outsidePath }),
  });
  const body = await response.json();
  assert.equal(response.status, 400); assert.equal(body.error.code, 'INVALID_FIRMWARE_PATH');
  assert.equal(JSON.stringify(body).includes(outsidePath), false);
});

test('FIRMWARE_SOURCE_DIR defaults beside backend and supports an override', (t) => {
  const env = { MQTT_PASSWORD: 'test-password', MQTT_CA_PATH: 'ca', TLS_CERT_PATH: 'cert', TLS_KEY_PATH: 'key', ADMIN_API_TOKEN: 'x'.repeat(40), SIGNING_PUBLIC_KEY_PATH: 'public.pem' };
  const baseDir = path.join(os.tmpdir(), 'iot-config', 'backend');
  assert.equal(loadConfig(env, baseDir).firmwareSourceDir, path.resolve(baseDir, '../release'));
  assert.equal(loadConfig({ ...env, FIRMWARE_SOURCE_DIR: 'custom-release' }, baseDir).firmwareSourceDir, path.resolve(baseDir, 'custom-release'));
  t.diagnostic('configuration values use placeholders only; no external credentials or files are accessed');
});

test('unknown request and expired command status are ignored and logged', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const issued = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  const message = { request_id: issued.request_id, device_id: 'esp32-001', state: 'received', progress: 0, ts: new Date().toISOString() };
  await f.updates.handleStatus({ ...message, request_id: '123e4567-e89b-42d3-a456-426614174001' });
  f.advance(721_000);
  assert.equal(await f.updates.handleStatus(message), null);
  assert.equal((await f.updates.get(issued.request_id)).state, 'expired');
  assert.ok(f.events.list().some((e) => e.type === 'replay_detected' && e.details.reason === 'unknown_request_id'));
  assert.ok(f.events.list().some((e) => e.type === 'expired_update_status'));
});

test('illegal transitions are rejected and duplicate status is idempotent', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const update = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  const ts = new Date().toISOString(); const msg = { request_id: update.request_id, device_id: 'esp32-001', state: 'received', progress: 0, ts };
  const first = await f.updates.handleStatus(msg); const second = await f.updates.handleStatus(msg);
  assert.equal(first.state, 'received'); assert.equal(second.state, 'received');
  await assert.rejects(() => f.updates.handleStatus({ ...msg, state: 'installing', ts: new Date(Date.now() + 1).toISOString() }), { code: 'ILLEGAL_TRANSITION' });
});

test('malformed MQTT status payload is rejected by schema', () => {
  assert.equal(statusSchema.safeParse({ request_id: 'nope' }).success, false);
});

test('stale sent update expires on read and permits a new request', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const first = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  f.advance(721_000);
  assert.equal((await f.updates.get(first.request_id)).state, 'expired');
  assert.equal((await f.updates.get(first.request_id)).error_code, 'DEVICE_RESPONSE_TIMEOUT');
  assert.ok(f.events.list().some((e) => e.type === 'update_expired' && e.severity === 'warning' && e.details.message === 'update expired without device response'));
  assert.equal((await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' })).state, 'sent');
});

test('expiry sweep after backend service restart expires persisted silent commands', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const pending = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  f.advance(721_000);
  const restartedUpdates = createUpdatesService({ store: f.store, mqtt: f.mqtt, devices: f.devices, firmwares: f.firmwares, events: f.events, ttlSeconds: 600, now: f.now });
  const expired = await restartedUpdates.expireDue();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].request_id, pending.request_id);
  assert.equal(expired[0].state, 'expired');
  assert.equal(expired[0].error_code, 'DEVICE_RESPONSE_TIMEOUT');
});

test('active download with a recent device response receives its expiry grace', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const u = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  f.advance(590_000);
  await f.updates.handleStatus({ request_id: u.request_id, device_id: 'esp32-001', state: 'received', progress: 0 });
  f.advance(15_000);
  await f.updates.handleStatus({ request_id: u.request_id, device_id: 'esp32-001', state: 'downloading', progress: 40 });
  f.advance(20_000);
  assert.equal((await f.updates.get(u.request_id)).state, 'downloading');
});

test('expiry waits for the full grace period after expires_at even if the last status was before expiry', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const u = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  f.advance(590_000);
  await f.updates.handleStatus({ request_id: u.request_id, device_id: 'esp32-001', state: 'received', progress: 0 });
  f.advance(129_000);
  assert.equal((await f.updates.get(u.request_id)).state, 'received');
  f.advance(1_000);
  const expired = await f.updates.get(u.request_id);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.error_code, 'DEVICE_RESPONSE_TIMEOUT');
});

test('device status schema accepts all supported states and rejects invalid fields', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const u = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  for (const state of ['received', 'downloading', 'verifying', 'installing', 'rebooting', 'success', 'failed', 'rolled_back', 'rejected']) {
    assert.equal(statusSchema.safeParse({ request_id: u.request_id, device_id: 'esp32-001', state, progress: 25 }).success, true, state);
  }
  const base = { request_id: u.request_id, device_id: 'esp32-001', state: 'received', progress: 0 };
  assert.equal(statusSchema.safeParse({ ...base, state: 'mystery' }).success, false);
  assert.equal(statusSchema.safeParse({ ...base, progress: 101 }).success, false);
  assert.equal(statusSchema.safeParse({ ...base, progress: 1.5 }).success, false);
  assert.equal(statusSchema.safeParse({ ...base, ts: '2026-11-18T12:33:05Z' }).success, true);
  assert.equal(statusSchema.safeParse({ ...base, ts: 'not-a-timestamp' }).success, false);
  assert.equal(statusSchema.safeParse({ ...base, error_code: 'untrusted_url' }).success, true);
  assert.equal(statusSchema.safeParse({ ...base, error_code: 'Bad Error' }).success, false);
  assert.equal(await f.updates.handleStatus({ ...base, request_id: '123e4567-e89b-42d3-a456-426614174001' }), null);
  assert.equal(await f.updates.handleStatus({ ...base, device_id: 'esp32-other' }), null);
  assert.equal((await f.updates.get(u.request_id)).state, 'sent');
});

test('firmware status payload contract advances full success and direct rejection histories', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001' });
  const time = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const success = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  const send = async (state, progress, extra = {}) => {
    const payload = { request_id: success.request_id, device_id: 'esp32-001', state, progress, ...extra, ts: time };
    assert.equal(statusSchema.safeParse(payload).success, true, `${state} payload shape`);
    return f.updates.handleStatus(payload);
  };
  await send('received', 0);
  await send('downloading', 0, { version: '1.2.0' });
  const progress = await send('downloading', 45, { version: '1.2.0' });
  assert.equal(progress.progress, 45, 'new progress in the same timestamp second is retained');
  await send('verifying', 100, { version: '1.2.0' });
  await send('installing', 100, { version: '1.2.0' });
  await send('rebooting', 100, { version: '1.2.0' });
  const completed = await send('success', 100, { version: '1.2.0' });
  assert.deepEqual(completed.history.map((entry) => entry.state), ['created', 'sent', 'received', 'downloading', 'verifying', 'installing', 'rebooting', 'success']);
  assert.equal(completed.progress, 100);

  await f.register('1.3.0');
  await f.devices.updateStatus({ device_id: 'esp32-001', version: '1.2.0' });
  const rejected = await f.updates.request({ device_id: 'esp32-001', version: '1.3.0' });
  const refused = { request_id: rejected.request_id, device_id: 'esp32-001', state: 'rejected', progress: 0, error_code: 'untrusted_url', version: '1.3.0', ts: time };
  assert.equal(statusSchema.safeParse(refused).success, true);
  const final = await f.updates.handleStatus(refused);
  assert.equal(final.state, 'rejected');
  assert.equal(final.error_code, 'untrusted_url');
  assert.equal(final.history.at(-1).error_code, 'untrusted_url');
});

test('rolled_back and rejected statuses produce security events and success updates device version', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register(); await f.devices.updateStatus({ device_id: 'esp32-001', min_allowed_version: '1.0.0' });
  const rejected = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  await f.updates.handleStatus({ request_id: rejected.request_id, device_id: 'esp32-001', state: 'rejected', progress: 0, error_code: 'wrong_target' });
  assert.ok(f.events.list().some((e) => e.type === 'update_rejected' && e.details.error_code === 'wrong_target'));
  const rolled = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  for (const state of ['received', 'downloading', 'verifying', 'installing']) await f.updates.handleStatus({ request_id: rolled.request_id, device_id: 'esp32-001', state, progress: 50 });
  await f.updates.handleStatus({ request_id: rolled.request_id, device_id: 'esp32-001', state: 'rolled_back', progress: 100, error_code: 'new_app_not_confirmed' });
  assert.ok(f.events.list().some((e) => e.type === 'update_rolled_back' && e.severity === 'high' && e.details.error_code === 'new_app_not_confirmed'));
  const success = await f.updates.request({ device_id: 'esp32-001', version: '1.2.0' });
  for (const state of ['received', 'downloading', 'verifying', 'installing', 'rebooting']) await f.updates.handleStatus({ request_id: success.request_id, device_id: 'esp32-001', state, progress: 50 });
  await f.updates.handleStatus({ request_id: success.request_id, device_id: 'esp32-001', state: 'success', progress: 100 });
  assert.equal(f.devices.get('esp32-001').version, '1.2.0');
  await f.devices.updateStatus({ device_id: 'esp32-001', target: 'esp32', version: '1.3.0', state: 'online', uptime_s: 9, min_allowed_version: '0.9.0' });
  assert.equal(f.devices.get('esp32-001').version, '1.3.0');
  assert.equal(f.devices.get('esp32-001').min_allowed_version, '1.0.0');
});

test('missing and wrong admin tokens return a generic 401 and create audit events', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const config = { adminApiToken: 'a'.repeat(40), firmwareDir: path.join(f.dir, 'firmware') };
  const services = { events: f.events, devices: f.devices, firmwares: f.firmwares, updates: f.updates };
  const server = createServer(createApp({ config, services, mqtt: { connected: false }, logger: { error() {} } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/devices`;
  for (const headers of [{}, { Authorization: 'Bearer wrong-token' }]) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  assert.equal(f.events.list().filter((e) => e.type === 'auth_failure').length, 2);
});

test('firmware server supports byte ranges and rejects unsafe paths', async (t) => {
  const f = await fixture(); t.after(f.cleanup); await f.register();
  const config = { adminApiToken: 'a'.repeat(40), firmwareDir: path.join(f.dir, 'firmware') };
  const services = { events: f.events, devices: f.devices, firmwares: f.firmwares, updates: f.updates };
  const server = createServer(createApp({ config, services, mqtt: { connected: false }, logger: { error() {} } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const range = await fetch(`${base}/firmware/esp32/1.2.0/firmware.bin`, { headers: { Range: 'bytes=9-15' } });
  assert.equal(range.status, 206); assert.equal(await range.text(), 'payload');
  assert.equal((await fetch(`${base}/firmware/esp32/../store.json`)).status, 404);
});

test('malformed MQTT messages are dropped without calling handlers or crashing', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'iot-mqtt-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const ca = path.join(dir, 'ca.crt'); await writeFile(ca, 'public test CA');
  class MockClient extends EventEmitter {
    options = {};
    subscribe(_topics, _options, callback) { callback?.(); }
    publish(_topic, _payload, _options, callback) { callback?.(); }
    end(_force, _options, callback) { callback?.(); }
  }
  const mock = new MockClient(); let handled = 0; const warnings = [];
  const client = await createMqttClient({ mqttUrl: 'mqtts://localhost:8883', mqttUsername: 'backend', mqttPassword: 'x', mqttCaPath: ca }, { handlers: { async handle() { handled += 1; } }, logger: { info() {}, warn(fields, message) { warnings.push({ fields, message }); }, error() {} }, connectImpl: () => mock });
  mock.emit('message', 'iot/stm32/update/status', Buffer.from('{invalid json'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handled, 0); assert.equal(client.connected, false);
  assert.match(warnings[0].fields.reason, /JSON|position|property/i);
});

test('release scanner registers valid signed folders, is idempotent, and rejects tampering, symlinks, and oversized files', async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const validDir = path.join(f.firmwareSourceDir, '1.2.0'); await mkdir(validDir);
  const bytes = Buffer.from('scan valid binary'); const manifest = await f.makeManifest('1.2.0', bytes, '1.0.0');
  await writeFile(path.join(validDir, 'manifest.json'), JSON.stringify(manifest)); await writeFile(path.join(validDir, 'firmware.bin'), bytes);
  const ignored = path.join(f.firmwareSourceDir, 'notes'); await mkdir(ignored);
  await writeFile(path.join(ignored, 'manifest.json'), '{}');
  const tamperedDir = path.join(f.firmwareSourceDir, '1.3.0'); await mkdir(tamperedDir);
  const tampered = await f.makeManifest('1.3.0', bytes, '1.0.0'); tampered.sha256 = '0'.repeat(64);
  await writeFile(path.join(tamperedDir, 'manifest.json'), JSON.stringify(tampered)); await writeFile(path.join(tamperedDir, 'firmware.bin'), bytes);
  const binaryTamperedDir = path.join(f.firmwareSourceDir, '1.3.1'); await mkdir(binaryTamperedDir);
  const binaryTamperedManifest = await f.makeManifest('1.3.1', bytes, '1.0.0');
  await writeFile(path.join(binaryTamperedDir, 'manifest.json'), JSON.stringify(binaryTamperedManifest)); await writeFile(path.join(binaryTamperedDir, 'firmware.bin'), Buffer.from('altered binary'));
  const hugeDir = path.join(f.firmwareSourceDir, '1.4.0'); await mkdir(hugeDir);
  await writeFile(path.join(hugeDir, 'manifest.json'), '{}'); const hugeFile = path.join(hugeDir, 'firmware.bin'); await writeFile(hugeFile, Buffer.alloc(1)); await truncate(hugeFile, 100 * 1024 * 1024 + 1);
  const external = path.join(f.dir, 'outside.bin'); await writeFile(external, bytes);
  const linkDir = path.join(f.firmwareSourceDir, '1.5.0'); await mkdir(linkDir);
  const linkManifest = await f.makeManifest('1.5.0', bytes, '1.0.0'); await writeFile(path.join(linkDir, 'manifest.json'), JSON.stringify(linkManifest));
  await symlink(external, path.join(linkDir, 'firmware.bin'));
  const externalDir = path.join(f.dir, 'outside-release'); await mkdir(externalDir);
  await symlink(externalDir, path.join(f.firmwareSourceDir, '1.6.0'), 'junction');
  const first = await f.firmwares.scanReleases();
  assert.deepEqual(first.find((x) => x.version === '1.2.0'), { version: '1.2.0', result: 'registered' });
  assert.equal(first.some((x) => x.version === 'notes'), false);
  assert.equal(first.find((x) => x.version === '1.3.0')?.result, 'rejected');
  assert.equal(first.find((x) => x.version === '1.3.1')?.result, 'rejected');
  assert.equal(first.find((x) => x.version === '1.4.0')?.result, 'rejected');
  assert.equal(first.find((x) => x.version === '1.5.0')?.result, 'rejected');
  assert.equal(first.find((x) => x.version === '1.6.0')?.result, 'rejected');
  const second = await f.firmwares.scanReleases();
  assert.equal(second.find((x) => x.version === '1.2.0')?.result, 'already_registered');
  assert.equal(f.store.list('firmwares').filter((x) => x.version === '1.2.0').length, 1);
  assert.ok(f.events.list().some((event) => event.type === 'firmware_release_scan_rejected'));
  assert.ok(f.events.list().some((event) => event.type === 'firmware_release_scanned'));
});

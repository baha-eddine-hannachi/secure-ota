import { randomUUID } from 'node:crypto';
import { compareSemver } from '../utils/semver.js';

const NEXT = {
  created: ['sent', 'expired'], sent: ['received', 'failed', 'rejected', 'expired'], received: ['downloading', 'failed', 'rejected', 'expired'],
  downloading: ['verifying', 'failed', 'rejected', 'expired'], verifying: ['installing', 'failed', 'rejected', 'expired'], installing: ['rebooting', 'failed', 'rolled_back', 'expired'],
  rebooting: ['success', 'failed', 'rolled_back', 'expired'], success: [], failed: [], rolled_back: [], rejected: [], expired: [],
};
const mapState = { received: 'received', downloading: 'downloading', verifying: 'verifying', installing: 'installing', rebooting: 'rebooting', success: 'success', failed: 'failed', rolled_back: 'rolled_back', rejected: 'rejected' };

export function createUpdatesService({ store, mqtt, devices, firmwares, events, ttlSeconds = 600, now = () => Date.now() }) {
  const seen = new Set();
  const terminal = ['success', 'failed', 'rolled_back', 'rejected', 'expired'];
  const ordinaryGraceMs = 2 * 60_000;
  const rebootGraceMs = 5 * 60_000;
  function transition(update, state, metadata = {}) {
    if (!NEXT[update.state]?.includes(state)) throw Object.assign(new Error(`Illegal update transition: ${update.state} -> ${state}`), { code: 'ILLEGAL_TRANSITION', status: 409 });
    return { ...update, ...metadata, state, updated_at: new Date(now()).toISOString(), history: [...update.history, { state, timestamp: new Date(now()).toISOString(), ...metadata }] };
  }
  async function saveTransition(update, state, metadata) { const next = transition(update, state, metadata); await store.put('updates', next.request_id, next); return next; }
  async function expireIfDue(update) {
    if (!update || terminal.includes(update.state)) return update;
    const expiresAt = Date.parse(update.expires_at);
    if (expiresAt > now()) return update;
    const statusAt = Date.parse(update.last_status_at ?? update.expires_at);
    const grace = ['installing', 'rebooting'].includes(update.state) ? rebootGraceMs : ordinaryGraceMs;
    if (now() < expiresAt + grace || now() - statusAt < grace) return update;
    const expired = await saveTransition(update, 'expired', { error_code: 'DEVICE_RESPONSE_TIMEOUT' });
    await events.record({ type: 'update_expired', severity: 'warning', device_id: update.device_id, details: { request_id: update.request_id, error_code: 'DEVICE_RESPONSE_TIMEOUT', message: 'update expired without device response' } });
    return expired;
  }
  return {
    async request({ device_id, version, request_id = randomUUID() }) {
      if (store.get('updates', request_id)) {
        const existing = store.get('updates', request_id);
        if (existing.device_id !== device_id || existing.version !== version) throw Object.assign(new Error('request_id already belongs to a different update'), { code: 'REQUEST_ID_CONFLICT', status: 409 });
        return existing;
      }
      for (const update of store.list('updates').filter((u) => u.device_id === device_id)) await expireIfDue(update);
      const active = store.list('updates').find((u) => u.device_id === device_id && !terminal.includes(u.state));
      if (active) throw Object.assign(new Error('Device already has an active update'), { code: 'UPDATE_ACTIVE', status: 409 });
      const device = devices.get(device_id);
      if (!device) throw Object.assign(new Error('Unknown device'), { code: 'DEVICE_NOT_FOUND', status: 404 });
      if (device.online === false) {
        await events.record({ type: 'device_offline', device_id, severity: 'warning', details: { reason: 'device_reported_offline' } });
        throw Object.assign(new Error('Device is offline'), { code: 'DEVICE_OFFLINE', status: 409 });
      }
      const firmware = store.get('firmwares', `${device.target ?? (device_id.startsWith('esp32') ? 'esp32' : 'stm32')}:${version}`);
      if (!firmware) throw Object.assign(new Error('Firmware version is not registered'), { code: 'FIRMWARE_NOT_FOUND', status: 404 });
      if (device.version) {
        let versionOrder;
        try { versionOrder = compareSemver(version, device.version); }
        catch {
          await events.record({ type: 'version_not_newer_refused', device_id, severity: 'warning', details: { requested_version: version, reported_version: device.version } });
          throw Object.assign(new Error('Requested version is not newer than device version'), { code: 'VERSION_NOT_NEWER', status: 409 });
        }
        if (versionOrder <= 0) {
          await events.record({ type: 'version_not_newer_refused', device_id, severity: 'warning', details: { requested_version: version, reported_version: device.version } });
          throw Object.assign(new Error('Requested version is not newer than device version'), { code: 'VERSION_NOT_NEWER', status: 409 });
        }
      }
      if (device.min_allowed_version && compareSemver(version, device.min_allowed_version) < 0) {
        await events.record({ type: 'anti_rollback_refused', device_id, severity: 'warning', details: { requested_version: version, min_allowed_version: device.min_allowed_version } });
        throw Object.assign(new Error('Requested version is below device minimum allowed version'), { code: 'ANTI_ROLLBACK', status: 409 });
      }
      const issued = now(); const update = { request_id, device_id, target: firmware.device_type, version, state: 'created', created_at: new Date(issued).toISOString(), issued_at: new Date(issued).toISOString(), expires_at: new Date(issued + ttlSeconds * 1000).toISOString(), history: [{ state: 'created', timestamp: new Date(issued).toISOString() }] };
      await store.put('updates', request_id, update);
      const command = { request_id, device_id, target: firmware.device_type, version, manifest_url: firmware.url, issued_at: update.issued_at, expires_at: update.expires_at };
      const sent = await saveTransition(update, 'sent');
      try { await mqtt.publishCommand(command); }
      catch (error) {
        await events.record({ type: 'device_offline', device_id, severity: 'warning', details: { reason: 'mqtt_publish_failed' } });
        const current = store.get('updates', request_id);
        if (current?.state === 'sent') await saveTransition(current, 'failed', { error_code: 'MQTT_PUBLISH_FAILED' });
        throw Object.assign(new Error('Unable to publish update command'), { code: 'MQTT_UNAVAILABLE', status: 503 });
      }
      return store.get('updates', request_id) ?? sent;
    },
    async handleStatus(message) {
      const update = store.get('updates', message.request_id);
      if (!update) {
        await events.record({ type: 'replay_detected', device_id: message.device_id, severity: 'warning', details: { reason: 'unknown_request_id', request_id: message.request_id } });
        return null;
      }
      if (update.device_id !== message.device_id) return null;
      if (update.state === 'expired') {
        await events.record({ type: 'replay_detected', device_id: message.device_id, severity: 'warning', details: { reason: 'expired_command', request_id: message.request_id } });
        return null;
      }
      if (['success', 'failed', 'rolled_back', 'rejected'].includes(update.state)) return update;
      const deviceTimestamp = typeof message.ts === 'string' ? Date.parse(message.ts) : now();
      if (message.ts && typeof message.ts === 'string' && deviceTimestamp < Date.parse(update.issued_at)) {
        await events.record({ type: 'replay_detected', device_id: message.device_id, severity: 'warning', details: { reason: 'status_predates_command', request_id: message.request_id } });
        return null;
      }
      const afterExpiry = await expireIfDue(update);
      if (afterExpiry.state === 'expired') { await events.record({ type: 'expired_update_status', device_id: message.device_id, severity: 'warning', details: { request_id: message.request_id } }); return null; }
      const key = `${message.request_id}:${message.state}:${deviceTimestamp}:${message.progress}:${message.error_code ?? ''}:${message.version ?? ''}`;
      if (seen.has(key)) return update;
      seen.add(key);
      const state = mapState[message.state];
      if (state === update.state) {
        const refreshed = { ...update, progress: message.progress, last_status_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() };
        await store.put('updates', update.request_id, refreshed);
        return refreshed;
      }
      if (!state || !NEXT[update.state]?.includes(state)) {
        if (update.history.some((entry) => entry.state === state)) return update;
        await events.record({ type: 'illegal_update_transition', device_id: message.device_id, details: { request_id: message.request_id, from: update.state, to: state ?? message.state } });
        throw Object.assign(new Error(`Illegal update transition: ${update.state} -> ${state ?? message.state}`), { code: 'ILLEGAL_TRANSITION', status: 409 });
      }
      const metadata = { progress: message.progress, error_code: message.error_code, reported_version: message.version, device_timestamp: message.ts, last_status_at: new Date(now()).toISOString() };
      const updated = await saveTransition(update, state, metadata);
      if (state === 'success') await devices.updateVersion(message.device_id, message.version ?? update.version);
      if (['failed', 'rejected', 'rolled_back'].includes(state)) await events.record({ type: `update_${state}`, severity: state === 'rolled_back' ? 'high' : 'warning', device_id: message.device_id, details: { request_id: message.request_id, error_code: message.error_code } });
      return updated;
    },
    async expireDue() {
      const expired = [];
      for (const update of store.list('updates')) { const next = await expireIfDue(update); if (next?.state === 'expired' && update.state !== 'expired') expired.push(next); }
      return expired;
    },
    async get(id) { return expireIfDue(store.get('updates', id)); },
    list: () => store.list('updates'),
  };
}

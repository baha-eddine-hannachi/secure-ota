import { compareSemver } from '../utils/semver.js';

export function createDevicesService(store) {
  return {
    list: () => store.list('devices').sort((a, b) => a.device_id.localeCompare(b.device_id)),
    get: (id) => store.get('devices', id),
    async updateStatus(message) {
      const old = store.get('devices', message.device_id) ?? { device_id: message.device_id };
      const next = { ...old, ...message, last_seen: message.ts ?? new Date().toISOString(), online: message.online ?? message.state !== 'offline' };
      if (old.min_allowed_version && message.min_allowed_version) {
        try { if (compareSemver(message.min_allowed_version, old.min_allowed_version) < 0) next.min_allowed_version = old.min_allowed_version; }
        catch { next.min_allowed_version = old.min_allowed_version; }
      }
      return store.put('devices', message.device_id, next);
    },
    async updateVersion(id, version) {
      const old = store.get('devices', id) ?? { device_id: id };
      return store.put('devices', id, { ...old, version });
    },
    async updateTelemetry(message) {
      const old = store.get('devices', message.device_id) ?? { device_id: message.device_id };
      await store.put('devices', message.device_id, { ...old, last_seen: message.ts ?? new Date().toISOString() });
      return store.append('telemetry', { ...message, received_at: new Date().toISOString() });
    },
  };
}

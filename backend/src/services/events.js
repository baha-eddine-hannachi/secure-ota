import { randomUUID } from 'node:crypto';

export function createEventsService(store, logger) {
  return {
    async record({ type, device_id = null, severity = 'warning', details = {} }) {
      const event = { id: randomUUID(), type, device_id, severity, details, timestamp: new Date().toISOString() };
      await store.append('events', event);
      logger?.[severity === 'critical' || severity === 'error' ? 'error' : 'warn']({ type, device_id }, 'security event recorded');
      return event;
    },
    list(filters = {}) {
      return store.list('events').filter((e) => (!filters.device_id || e.device_id === filters.device_id) && (!filters.severity || e.severity === filters.severity) && (!filters.type || e.type === filters.type)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    },
  };
}

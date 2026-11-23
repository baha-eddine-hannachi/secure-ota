import { topics } from '../config/topics.js';

export function createMqttHandlers({ updates, devices, events, logger }) {
  return {
    async handle(topic, message) {
      if (topic === topics.updateStatus) return updates.handleStatus(message);
      if (topic === topics.deviceStatus || topic === topics.gatewayStatus) return devices.updateStatus(message);
      if (topic === topics.telemetry) return devices.updateTelemetry(message);
      if (topic === topics.securityEvents) {
        // Device-reported security events are evidence; retain the payload as details without treating it as authorization.
        return events.record({ type: message.event, device_id: message.device_id, severity: message.severity, details: message.details ?? {} });
      }
      logger.warn({ topic }, 'Message on unhandled topic dropped');
    },
  };
}

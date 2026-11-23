export const topics = Object.freeze({
  updateCommand: 'iot/stm32/update/command',
  updateStatus: 'iot/stm32/update/status',
  deviceStatus: 'iot/stm32/status',
  telemetry: 'iot/stm32/telemetry',
  securityEvents: 'iot/stm32/security/events',
  gatewayStatus: 'iot/esp32/status',
});

export const inboundTopics = Object.freeze([
  topics.updateStatus,
  topics.deviceStatus,
  topics.telemetry,
  topics.securityEvents,
  topics.gatewayStatus,
]);

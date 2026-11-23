import mqtt from 'mqtt';
import { readFile } from 'node:fs/promises';
import { inboundTopics, topics } from '../config/topics.js';
import { statusSchema, deviceStatusSchema, telemetrySchema, securityEventSchema } from './schemas.js';

export async function createMqttClient(config, { handlers, logger, connectImpl = mqtt.connect }) {
  const ca = await readFile(config.mqttCaPath);
  const client = connectImpl(config.mqttUrl, {
    username: config.mqttUsername, password: config.mqttPassword, ca, rejectUnauthorized: true,
    minVersion: 'TLSv1.2', reconnectPeriod: 1000, reconnectOnConnackError: true, clean: true,
  });
  let connected = false;
  let reconnectDelay = 1000;
  client.on('connect', () => { connected = true; reconnectDelay = 1000; client.options.reconnectPeriod = reconnectDelay; logger.info('MQTT connected'); client.subscribe(inboundTopics, { qos: 1 }, (err) => { if (err) logger.error({ err: err.message }, 'MQTT subscribe failed'); }); });
  client.on('reconnect', () => { reconnectDelay = Math.min(30_000, Math.round(reconnectDelay * 1.8)); client.options.reconnectPeriod = reconnectDelay; logger.info({ delay_ms: reconnectDelay }, 'MQTT reconnecting'); });
  client.on('close', () => { connected = false; logger.warn('MQTT disconnected'); });
  client.on('offline', () => { connected = false; logger.warn('MQTT offline'); });
  client.on('error', (err) => logger.error({ error: err.message }, 'MQTT error'));
  client.on('message', async (topic, payload) => {
    try {
      if (payload.length > 64 * 1024) throw new Error('payload too large');
      const parsed = JSON.parse(payload.toString('utf8'));
      const schema = topic === topics.updateStatus ? statusSchema : topic === topics.securityEvents ? securityEventSchema : topic === topics.telemetry ? telemetrySchema : deviceStatusSchema;
      const result = schema.safeParse(parsed);
      if (!result.success) {
        const reason = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.code}`).join(', ');
        logger.warn({ topic, reason }, 'Malformed MQTT message dropped'); return;
      }
      await handlers.handle(topic, result.data);
    } catch (err) { logger.warn({ topic, reason: err.message }, 'Malformed MQTT message dropped'); }
  });
  return {
    get connected() { return connected; },
    publishCommand(command) {
      return new Promise((resolve, reject) => client.publish(topics.updateCommand, JSON.stringify(command), { qos: 1, retain: false }, (err) => err ? reject(err) : resolve()));
    },
    close() { return new Promise((resolve) => client.end(false, {}, resolve)); },
    raw: client,
  };
}

import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { loadConfig } from './config/env.js';
import { createLogger } from './utils/logger.js';
import { createStore } from './store/index.js';
import { createEventsService } from './services/events.js';
import { createDevicesService } from './services/devices.js';
import { createFirmwaresService } from './services/firmwares.js';
import { createUpdatesService } from './services/updates.js';
import { createMqttHandlers } from './mqtt/handlers.js';
import { createMqttClient } from './mqtt/client.js';
import { createApp } from './http/app.js';
import { createTestResultsService } from './services/testResults.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const store = await createStore(path.resolve('data/store.json'));
const [cert, key] = await Promise.all([readFile(config.tlsCertPath), readFile(config.tlsKeyPath)]);
const sanEntries = new X509Certificate(cert).subjectAltName?.split(/,\s*/) ?? [];
// Fail before opening MQTT connections if the certificate does not authenticate the device URL.
const backendHost = new URL(config.firmwareBaseUrl).hostname;
const requiredSan = net.isIP(backendHost) ? `IP Address:${backendHost}` : `DNS:${backendHost}`;
if (!sanEntries.includes(requiredSan)) throw new Error(`TLS certificate SAN must include configured backend host (${net.isIP(backendHost) ? 'IP' : 'DNS'})`);
const events = createEventsService(store, logger);
const devices = createDevicesService(store);
const firmwares = createFirmwaresService({ store, firmwareDir: config.firmwareDir, firmwareSourceDir: config.firmwareSourceDir, firmwareBaseUrl: config.firmwareBaseUrl, publicKeyPath: config.signingPublicKeyPath, events });
const handlerRef = { handle: async () => {} };
const mqtt = await createMqttClient(config, { handlers: handlerRef, logger });
const updates = createUpdatesService({ store, mqtt, devices, firmwares, events, ttlSeconds: config.commandTtlSeconds });
const testResults = createTestResultsService(path.resolve('reports'));
const handlers = createMqttHandlers({ updates, devices, events, logger });
handlerRef.handle = handlers.handle;
const app = createApp({ config, services: { events, devices, firmwares, updates, testResults }, mqtt, logger });
const apiServer = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, app);
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(config.httpPort, resolve); });
logger.info({ port: config.httpPort }, 'HTTPS API and firmware server listening');
const expiryTimer = setInterval(() => updates.expireDue().catch((e) => logger.error({ error: e.message }, 'Update expiry sweep failed')), 30_000);
expiryTimer.unref();

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down'); clearInterval(expiryTimer);
  await Promise.all([new Promise((resolve) => apiServer.close(resolve)), mqtt.close()]);
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

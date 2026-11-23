import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

const schema = z.object({
  MQTT_URL: z.url().default('mqtts://10.210.189.35:8883'),
  MQTT_USERNAME: z.string().min(1).default('backend'),
  MQTT_PASSWORD: z.string().min(1),
  MQTT_CA_PATH: z.string().min(1),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  TLS_CERT_PATH: z.string().min(1),
  TLS_KEY_PATH: z.string().min(1),
  ADMIN_API_TOKEN: z.string().min(32),
  FIRMWARE_DIR: z.string().default('./data/firmware'),
  FIRMWARE_SOURCE_DIR: z.string().default('../release'),
  FIRMWARE_BASE_URL: z.url().default('https://10.210.189.35:8443'),
  COMMAND_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SIGNING_PUBLIC_KEY_PATH: z.string().min(1),
  DEVICE_ID: z.string().default('esp32-001'),
});

export function loadConfig(env = process.env, baseDir = process.cwd()) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Do not include invalid values in startup errors; env may contain credentials.
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return Object.freeze({
    mqttUrl: parsed.data.MQTT_URL,
    mqttUsername: parsed.data.MQTT_USERNAME,
    mqttPassword: parsed.data.MQTT_PASSWORD,
    mqttCaPath: path.resolve(baseDir, parsed.data.MQTT_CA_PATH),
    httpPort: parsed.data.HTTP_PORT,
    tlsCertPath: path.resolve(baseDir, parsed.data.TLS_CERT_PATH),
    tlsKeyPath: path.resolve(baseDir, parsed.data.TLS_KEY_PATH),
    adminApiToken: parsed.data.ADMIN_API_TOKEN,
    firmwareDir: path.resolve(baseDir, parsed.data.FIRMWARE_DIR),
    firmwareSourceDir: path.resolve(baseDir, parsed.data.FIRMWARE_SOURCE_DIR),
    firmwareBaseUrl: parsed.data.FIRMWARE_BASE_URL.replace(/\/$/, ''),
    commandTtlSeconds: parsed.data.COMMAND_TTL_SECONDS,
    logLevel: parsed.data.LOG_LEVEL,
    signingPublicKeyPath: path.resolve(baseDir, parsed.data.SIGNING_PUBLIC_KEY_PATH),
    deviceId: parsed.data.DEVICE_ID,
  });
}

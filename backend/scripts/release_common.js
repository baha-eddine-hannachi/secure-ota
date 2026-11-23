import 'dotenv/config';
import https from 'node:https';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out[arg.slice(2)] = true;
  }
  return out;
}

export function settings(baseUrlOverride, { requireToken = true } = {}) {
  const baseUrl = (baseUrlOverride || process.env.FIRMWARE_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl || new URL(baseUrl).protocol !== 'https:') throw new Error('FIRMWARE_BASE_URL/--base-url must be an HTTPS URL');
  if (baseUrlOverride && process.env.FIRMWARE_BASE_URL && baseUrl !== process.env.FIRMWARE_BASE_URL.replace(/\/$/, '')) throw new Error('--base-url must match the configured FIRMWARE_BASE_URL');
  const apiToken = process.env.ADMIN_API_TOKEN;
  if (requireToken && !apiToken) throw new Error('ADMIN_API_TOKEN is missing from .env');
  const caPath = path.resolve(process.cwd(), process.env.CA_CERT || '..\\mosq\\ca.crt');
  return { baseUrl, apiToken: apiToken ?? '', caPath };
}

export async function requestJson(config, method, route, body, { rawBody = false } = {}) {
  const ca = await readFile(config.caPath);
  const url = new URL(route, `${config.baseUrl}/`);
  const payload = body === undefined ? undefined : (rawBody ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, ca, headers: { Authorization: `Bearer ${config.apiToken}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let data;
        try { data = text ? JSON.parse(text) : {}; } catch { return reject(new Error(`Backend returned invalid JSON (HTTP ${res.statusCode})`)); }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', (error) => reject(new Error(`HTTPS request failed: ${error.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export function failFor(response) {
  if (response.status >= 200 && response.status < 300) return;
  const code = response.data?.error?.code ?? 'HTTP_ERROR';
  const message = response.data?.error?.message ?? `HTTP ${response.status}`;
  if (code === 'FIRMWARE_VERSION_EXISTS') throw new Error(`Release version already exists with different bytes; choose a new version (${code}).`);
  if (code === 'INVALID_MANIFEST') throw new Error(`Backend rejected the manifest; check semantic versions and signing inputs (${code}).`);
  throw new Error(`${message} (${code}, HTTP ${response.status})`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function printFirmware(firmware) {
  console.log(`Version | Size | SHA-256 | Signature | Registered`);
  console.log(`${firmware.version} | ${firmware.size} | ${String(firmware.sha256).slice(0, 12)}… | ${firmware.signature_alg} | ${firmware.registered_at ?? '—'}`);
}

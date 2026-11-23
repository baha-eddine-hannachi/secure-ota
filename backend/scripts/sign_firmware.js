import 'dotenv/config';
import { createCipheriv, createHash, sign, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSemver } from '../src/utils/semver.js';

function option(name, required = true) {
  const value = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (required && !value) throw new Error(`Missing --${name}`);
  return value;
}
export async function signFirmware({ firmwareInput, version, privateKeyPath, deviceType = 'esp32', minVersion = '0.0.0', baseUrl, output, encrypt = false, encryptionKeyPath }) {
  firmwareInput = path.resolve(firmwareInput); privateKeyPath = path.resolve(privateKeyPath); output = path.resolve(output ?? path.dirname(firmwareInput));
  if (!['esp32', 'stm32'].includes(deviceType)) throw new Error('--device-type must be esp32 or stm32');
  parseSemver(version); parseSemver(minVersion);
  if (!baseUrl || new URL(baseUrl).protocol !== 'https:') throw new Error('--base-url must use HTTPS');
  await mkdir(output, { recursive: true });
  let firmware = await readFile(firmwareInput); let enc;
  if (encrypt) {
    const aesKey = await readFile(path.resolve(encryptionKeyPath));
    if (aesKey.length !== 32) throw new Error('Encryption key file must contain exactly 32 raw bytes');
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    firmware = Buffer.concat([cipher.update(firmware), cipher.final()]);
    enc = { alg: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), key_id: 'k1' };
  }
  const sha256 = createHash('sha256').update(firmware).digest('hex');
  const signedMessage = `IOTFW1|${deviceType}|${version}|${minVersion}|${firmware.length}|${sha256}|${enc ? '1' : '0'}`;
  const signature = sign('sha256', Buffer.from(signedMessage, 'utf8'), { key: await readFile(privateKeyPath), dsaEncoding: 'ieee-p1363' }).toString('base64');
  await writeFile(path.join(output, 'firmware.bin'), firmware, { flag: 'w', mode: 0o600 });
  const manifest = { device_type: deviceType, version, min_version: minVersion, size: firmware.length, sha256, signature, signature_alg: 'ECDSA-P256-SHA256-P1363', encrypted: Boolean(enc), ...(enc ? { enc } : {}), url: `${baseUrl.replace(/\/$/, '')}/firmware/${deviceType}/${version}/firmware.bin`, issued_at: new Date().toISOString() };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  return { output, manifest };
}

function cliOption(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\//, ''))) {
  try {
    const args = process.argv.slice(2); const firmwareInput = cliOption(args, 'firmware'); const version = cliOption(args, 'version');
    const baseUrl = cliOption(args, 'base-url', process.env.FIRMWARE_BASE_URL);
    if (!firmwareInput || !version || !baseUrl) throw new Error('Required: --firmware, --version, and --base-url or FIRMWARE_BASE_URL');
    const userHome = process.env.USERPROFILE ?? process.env.HOME;
    const result = await signFirmware({ firmwareInput, version, privateKeyPath: cliOption(args, 'key', path.join(userHome, '.iot-keys', 'signing-private.pem')), deviceType: cliOption(args, 'device-type', 'esp32'), minVersion: cliOption(args, 'min-version', '0.0.0'), baseUrl, output: cliOption(args, 'out', undefined), encrypt: args.includes('--encrypt'), encryptionKeyPath: cliOption(args, 'encryption-key') });
    process.stdout.write(`Wrote signed firmware and manifest to ${result.output}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

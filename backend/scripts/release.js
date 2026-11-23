import path from 'node:path';
import os from 'node:os';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { signFirmware } from './sign_firmware.js';
import { parseSemver, compareSemver } from '../src/utils/semver.js';
import { argsOf, failFor, printFirmware, requestJson, settings, sleep } from './release_common.js';

const SLOT_LIMIT = 0x1e0000;
function readVersion(args, name) { const version = args[name]; if (!version) throw new Error(`Missing --${name}`); parseSemver(version); return version; }

async function precheckFirmware(file, requestedVersion) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error('Firmware file is missing or empty.');
  if (info.size >= SLOT_LIMIT) throw new Error(`Firmware exceeds app slot limit (${SLOT_LIMIT} bytes).`);
  const bytes = await readFile(file);
  if (bytes[0] !== 0xe9) throw new Error('Firmware is not an ESP image (expected image magic 0xE9).');
  const desc = 32;
  if (bytes.readUInt32LE(desc) !== 0xabcd5432) throw new Error('ESP app descriptor magic is invalid; refusing to sign this binary.');
  const embedded = bytes.subarray(desc + 16, desc + 48).toString('utf8').split('\0', 1)[0];
  if (embedded !== requestedVersion) throw new Error(`The binary says ${embedded}, you asked for ${requestedVersion}: wrong build?`);
  return { bytes, size: info.size };
}

async function deploy(config, deviceId, version, yes) {
  const deviceResponse = await requestJson(config, 'GET', `/api/devices/${encodeURIComponent(deviceId)}`); failFor(deviceResponse);
  const device = deviceResponse.data.device;
  if (!device) throw new Error(`Device not found: ${deviceId}`);
  if (!device.online) throw new Error('Device is offline; deployment stopped.');
  if (device.version && compareSemver(version, device.version) <= 0) throw new Error('Target version is not newer than the device version.');
  const health = await requestJson(config, 'GET', '/api/health');
  if (health.status !== 200 || health.data.status !== 'ok' || health.data.mqtt_connected !== true) throw new Error('Backend/MQTT health check failed; deployment stopped.');
  const updates = await requestJson(config, 'GET', `/api/updates?device_id=${encodeURIComponent(deviceId)}&limit=100`); failFor(updates);
  if (updates.data.updates.some((item) => !['success', 'failed', 'rolled_back', 'rejected', 'expired'].includes(item.state))) throw new Error('Device already has an active update.');
  console.log(`Device: ${deviceId} | Current: ${device.version ?? 'unknown'} | Target: ${version}`);
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error('Deployment requires an interactive confirmation or --yes.');
    const readline = await import('node:readline/promises');
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await terminal.question('Send OTA command? Type yes to continue: '); terminal.close();
    if (answer.trim().toLowerCase() !== 'yes') { console.log('Deployment cancelled.'); return false; }
  }
  const response = await requestJson(config, 'POST', '/api/updates', { device_id: deviceId, version }); failFor(response);
  const update = response.data.update;
  if (!update?.request_id) throw new Error('Backend response did not include an update ID.');
  let lastState = '';
  let lastProgress = -1;
  const expires = Date.parse(update.expires_at) + 7 * 60_000;
  while (Date.now() <= expires) {
    const poll = await requestJson(config, 'GET', `/api/updates/${encodeURIComponent(update.request_id)}`);
    if (poll.status === 429) { await sleep(5000); continue; }
    failFor(poll);
    const current = poll.data.update;
    if (current.state !== lastState) {
      lastState = current.state;
      const progress = current.state === 'downloading' ? ` ${current.progress ?? 0}%` : '';
      const error = current.error_code ? ` error=${current.error_code}` : '';
      console.log(`${current.state}${progress}${error}`);
      if (current.state === 'downloading') lastProgress = current.progress ?? 0;
    } else if (current.state === 'downloading' && current.progress !== undefined) {
      if (current.progress !== lastProgress) { console.log(`downloading ${current.progress}%`); lastProgress = current.progress; }
    }
    if (current.state === 'success') return true;
    if (['failed', 'rolled_back', 'rejected', 'expired'].includes(current.state)) { process.exitCode = 1; return false; }
    await sleep(3000);
  }
  throw new Error('Deployment status timed out after command expiry and grace window.');
}

try {
  const args = argsOf(process.argv.slice(2));
  const version = readVersion(args, 'version'); const minVersion = args['min-version'] ?? '0.0.0'; parseSemver(minVersion);
  if (compareSemver(minVersion, version) > 0) throw new Error('--min-version must be less than or equal to --version.');
  const dryRun = Boolean(args['dry-run']);
  if (dryRun && !args.key) throw new Error('--dry-run requires an explicit temporary --key path; the default signing key is never used in dry-run.');
  if (dryRun && args.deploy) throw new Error('--dry-run cannot deploy.');
  const config = settings(args['base-url'], { requireToken: !dryRun });
  const firmwareInput = path.resolve(args.firmware ?? path.resolve(process.cwd(), '..', 'wifi_base', 'build', 'wifi_base.bin'));
  const checked = await precheckFirmware(firmwareInput, version);
  console.log(`Using backend: ${config.baseUrl}`);
  if (!dryRun) {
    const health = await requestJson(config, 'GET', '/api/health');
    if (health.status !== 200 || health.data.status !== 'ok') throw new Error('Backend health endpoint is unavailable.');
    const existing = await requestJson(config, 'GET', '/api/firmwares'); failFor(existing);
    if (existing.data.firmwares.some((item) => item.version === version && item.device_type === (args['device-type'] ?? 'esp32'))) throw new Error(`Version ${version} is already registered; choose a new version.`);
  }
  const keyDefault = path.join(os.homedir(), '.iot-keys', 'signing-private.pem');
  const tempOutput = dryRun ? await mkdtemp(path.join(os.tmpdir(), 'iot-release-dry-run-')) : null;
  const output = dryRun ? path.join(tempOutput, version) : path.resolve(process.cwd(), '..', 'release', version);
  const signed = await signFirmware({ firmwareInput, version, minVersion, deviceType: args['device-type'] ?? 'esp32', privateKeyPath: args.key ? path.resolve(args.key) : keyDefault, baseUrl: config.baseUrl, output });
  if (dryRun) {
    printFirmware({ ...signed.manifest, registered_at: 'mock backend (not registered)' });
    console.log('DRY RUN PASS | Temporary output signed with the explicitly supplied key; mocked health/registry checks passed; no backend contacted, no release registered, no OTA sent.');
    await rm(tempOutput, { recursive: true, force: true });
  } else {
    const manifestText = await readFile(path.join(signed.output, 'manifest.json'), 'utf8');
    const registrationBody = `{"manifest":${manifestText.trim()},"firmware_path":${JSON.stringify(path.join(signed.output, 'firmware.bin'))}}`;
    const registration = await requestJson(config, 'POST', '/api/firmwares', registrationBody, { rawBody: true }); failFor(registration);
    printFirmware(registration.data.firmware);
    if (args.deploy) {
      const success = await deploy(config, args.device ?? process.env.DEVICE_ID ?? 'esp32-001', version, Boolean(args.yes));
      if (!success) process.exitCode = 1;
    }
  }
  void checked;
} catch (error) { console.error(error.message); process.exitCode = 1; }

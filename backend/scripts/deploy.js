import { argsOf, failFor, requestJson, settings, sleep } from './release_common.js';
import { compareSemver, parseSemver } from '../src/utils/semver.js';
try {
  const args = argsOf(process.argv.slice(2)); const version = args.version; const deviceId = args.device ?? process.env.DEVICE_ID ?? 'esp32-001';
  if (!version) throw new Error('Usage: npm run deploy -- --version X.Y.Z [--device ID] [--yes]');
  const config = settings(args['base-url']);
  parseSemver(version);
  const device = await requestJson(config, 'GET', `/api/devices/${encodeURIComponent(deviceId)}`); failFor(device);
  if (!device.data.device?.online) throw new Error('Device is offline; deployment stopped.');
  if (device.data.device.version && compareSemver(version, device.data.device.version) <= 0) throw new Error('Target version is not newer than the device version.');
  const health = await requestJson(config, 'GET', '/api/health');
  if (health.status !== 200 || health.data.status !== 'ok' || !health.data.mqtt_connected) throw new Error('Backend/MQTT health check failed.');
  const updates = await requestJson(config, 'GET', `/api/updates?device_id=${encodeURIComponent(deviceId)}&limit=100`); failFor(updates);
  if (updates.data.updates.some((item) => !['success', 'failed', 'rolled_back', 'rejected', 'expired'].includes(item.state))) throw new Error('Device already has an active update.');
  console.log(`Device ${deviceId}: ${device.data.device?.version ?? 'unknown'} → ${version}`);
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new Error('Deployment requires an interactive confirmation or --yes.');
    const rl = await import('node:readline/promises'); const io = rl.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await io.question('Send OTA command? Type yes to continue: '); io.close();
    if (answer.trim().toLowerCase() !== 'yes') { console.log('Deployment cancelled.'); process.exit(0); }
  }
  const sent = await requestJson(config, 'POST', '/api/updates', { device_id: deviceId, version }); failFor(sent);
  const id = sent.data.update.request_id; const deadline = Date.parse(sent.data.update.expires_at) + 7 * 60_000; let prior = ''; let priorProgress = -1;
  while (Date.now() <= deadline) {
    const response = await requestJson(config, 'GET', `/api/updates/${encodeURIComponent(id)}`);
    if (response.status === 429) { await sleep(5000); continue; }
    failFor(response);
    const u = response.data.update;
    if (u.state !== prior || (u.state === 'downloading' && u.progress !== priorProgress)) {
      console.log(`${u.state}${u.state === 'downloading' ? ` ${u.progress ?? 0}%` : ''}${u.error_code ? ` error_code=${u.error_code}` : ''}`);
      prior = u.state; priorProgress = u.progress;
    }
    if (u.state === 'success') process.exit(0);
    if (['failed', 'rolled_back', 'rejected', 'expired'].includes(u.state)) process.exit(1);
    await sleep(3000);
  }
  throw new Error('Deployment status polling timed out.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

import { failFor, requestJson, settings } from './release_common.js';
try {
  const config = settings();
  const [devices, updates, firmwares] = await Promise.all([
    requestJson(config, 'GET', '/api/devices'), requestJson(config, 'GET', '/api/updates?limit=100'), requestJson(config, 'GET', '/api/firmwares'),
  ]);
  for (const result of [devices, updates, firmwares]) failFor(result);
  const device = devices.data.devices.find((item) => item.device_id === (process.env.DEVICE_ID ?? 'esp32-001'));
  console.log('Device | Version | Online | Last seen');
  console.log(`${device?.device_id ?? process.env.DEVICE_ID ?? 'esp32-001'} | ${device?.version ?? 'unknown'} | ${device?.online ? 'yes' : 'no'} | ${device?.last_seen ?? '—'}`);
  console.log('\nLatest updates');
  for (const update of updates.data.updates.slice(0, 5)) console.log(`${update.version} | ${update.state} | ${update.error_code ?? '—'} | ${update.request_id}`);
  console.log('\nRegistered firmware');
  for (const firmware of firmwares.data.firmwares) console.log(`${firmware.device_type} | ${firmware.version} | ${firmware.size} | ${firmware.sha256.slice(0, 12)}… | ${firmware.registered_at ?? '—'}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }

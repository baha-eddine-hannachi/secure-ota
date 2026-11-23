import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createAdminAuth } from '../middleware/auth.js';

const requestSchema = z.object({ device_id: z.string().min(1).max(64), version: z.string().min(1).max(64), request_id: z.uuid().optional(), source: z.enum(['dashboard', 'cli']).optional() }).strict();
const firmwareSchema = z.object({ manifest: z.record(z.string(), z.unknown()), firmware_path: z.string().min(1).max(1024) }).strict();
const updateStates = ['created', 'sent', 'received', 'downloading', 'verifying', 'installing', 'rebooting', 'success', 'failed', 'rolled_back', 'rejected', 'expired'];
const updateListQuery = z.object({ device_id: z.string().min(1).max(64).optional(), state: z.enum(updateStates).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

export function createApiRouter({ config, services, mqtt, logger }) {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok', mqtt_connected: mqtt.connected }));
  router.use(createAdminAuth(config.adminApiToken, services.events));
  router.get('/devices', (_req, res) => res.json({ devices: services.devices.list() }));
  router.get('/devices/:id', (req, res) => { const device = services.devices.get(req.params.id); return device ? res.json({ device }) : res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: 'Device not found' } }); });
  router.get('/firmwares', (_req, res) => res.json({ firmwares: services.firmwares.list().map(({ firmware_path, ...fw }) => ({ ...fw, deployed: services.devices.get(config.deviceId)?.version === fw.version })) }));
  router.post('/releases/scan', async (_req, res, next) => {
    try { return res.json({ results: await services.firmwares.scanReleases() }); } catch (error) { return next(error); }
  });
  router.get('/updates', async (req, res) => {
    const parsed = updateListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_QUERY', message: 'Invalid update list query' } });
    try {
      await services.updates.expireDue();
      const { device_id, state, limit } = parsed.data;
      const updates = services.updates.list()
        .filter((update) => (!device_id || update.device_id === device_id) && (!state || update.state === state))
        .sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at))
        .slice(0, limit)
        .map((update) => ({
          request_id: update.request_id, device_id: update.device_id, version: update.version, state: update.state, progress: update.progress ?? 0,
          created_at: update.created_at, updated_at: update.updated_at ?? update.created_at,
          error_code: update.error_code ?? [...(update.history ?? [])].reverse().find((entry) => entry.error_code)?.error_code ?? null,
          history_length: Array.isArray(update.history) ? update.history.length : 0,
        }));
      return res.json({ updates });
    } catch (error) { return res.status(error.status ?? 500).json({ error: { code: error.code ?? 'INTERNAL_ERROR', message: error.status ? error.message : 'Internal server error' } }); }
  });
  router.post('/firmwares', async (req, res, next) => {
    const parsed = firmwareSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid firmware registration request' } });
    try { const firmware = await services.firmwares.register({ manifest: parsed.data.manifest, firmwarePath: parsed.data.firmware_path }); const { firmware_path, ...safe } = firmware; return res.status(201).json({ firmware: safe }); } catch (e) { next(e); }
  });
  router.post('/updates', async (req, res, next) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid update request' } });
    try {
      const update = await services.updates.request({ ...parsed.data, request_id: parsed.data.request_id ?? randomUUID() });
      if (parsed.data.source === 'dashboard') await services.events.record({ type: 'deployment_requested_from_dashboard', severity: 'info', device_id: parsed.data.device_id, details: { version: parsed.data.version } });
      return res.status(202).json({ update });
    } catch (e) { next(e); }
  });
  router.get('/updates/:id', async (req, res) => { const update = await services.updates.get(req.params.id); return update ? res.json({ update }) : res.status(404).json({ error: { code: 'UPDATE_NOT_FOUND', message: 'Update not found' } }); });
  router.get('/test-results', async (_req, res, next) => {
    try {
      const results = await services.testResults.list();
      const counts = Object.fromEntries(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED'].map((status) => [status, results.filter((result) => result.status === status).length]));
      return res.json({ results, counts });
    } catch (error) { return next(error); }
  });
  router.get('/test-results/:id', async (req, res, next) => {
    try {
      const result = await services.testResults.get(req.params.id, { includeEvidence: true });
      return result ? res.json({ result }) : res.status(404).json({ error: { code: 'TEST_RESULT_NOT_FOUND', message: 'Test result not found' } });
    } catch (error) { return next(error); }
  });
  router.get('/overview', async (_req, res, next) => {
    try {
      await services.updates.expireDue();
      const devices = services.devices.list().map((device) => ({
        device_id: device.device_id, target: device.target ?? null, version: device.version ?? null,
        online: device.online ?? false, last_seen: device.last_seen ?? null, uptime_s: device.uptime_s ?? null,
      }));
      const allUpdates = services.updates.list().sort((a, b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at));
      const terminal = new Set(['success', 'failed', 'rolled_back', 'rejected', 'expired']);
      const updates = allUpdates.slice(0, 20).map((update) => ({
        request_id: update.request_id, device_id: update.device_id, version: update.version, state: update.state, progress: update.progress ?? 0,
        created_at: update.created_at, updated_at: update.updated_at ?? update.created_at,
        error_code: update.error_code ?? [...(update.history ?? [])].reverse().find((entry) => entry.error_code)?.error_code ?? null,
        history_length: Array.isArray(update.history) ? update.history.length : 0,
      }));
      const events = services.events.list().slice(0, 20).map((event) => ({ id: event.id, type: event.type, device_id: event.device_id, severity: event.severity, timestamp: event.timestamp, details: event.details }));
      const firmwares = services.firmwares.list().map(({ device_type, version, size, sha256, registered_at, signature_alg, encrypted }) => ({ device_type, version, size, sha256, registered_at: registered_at ?? null, signature_alg, encrypted: Boolean(encrypted), deployed: devices.some((device) => device.target === device_type && device.version === version) }));
      const results = await services.testResults.list();
      const counts = { devices: devices.length, firmwares: firmwares.length, updates: allUpdates.length, active_updates: allUpdates.filter((update) => !terminal.has(update.state)).length, security_events: services.events.list().length, tests: results.length, tests_passed: results.filter((result) => result.status === 'PASS').length };
      return res.json({ devices, active_updates: updates.filter((update) => !terminal.has(update.state)), updates, security_events: events, firmwares, counts, server_time: new Date().toISOString(), broker_connected: Boolean(mqtt.connected) });
    } catch (error) { return next(error); }
  });
  router.get('/test-report.html', async (_req, res, next) => {
    try {
      const html = await services.testResults.readReportHtml();
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      return res.type('html').send(html);
    } catch (error) { return next(error); }
  });
  router.get('/security-events', (req, res) => {
    const filters = {}; for (const key of ['device_id', 'severity', 'type']) if (typeof req.query[key] === 'string' && req.query[key].length <= 100) filters[key] = req.query[key];
    return res.json({ events: services.events.list(filters).slice(0, 1000) });
  });
  return router;
}

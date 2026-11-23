import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { createApiRouter } from './routes/api.js';
import { createFirmwareMiddleware } from './firmwareServer.js';

export function createApp(deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"] } } }));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use('/dashboard', express.static(path.resolve('public'), { index: 'dashboard.html', fallthrough: true, dotfiles: 'deny', maxAge: '5m' }));
  app.use(createFirmwareMiddleware(deps.config.firmwareDir));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use('/api', createApiRouter(deps));
  app.use((err, _req, res, _next) => {
    deps.logger.error({ code: err.code ?? 'INTERNAL_ERROR' }, 'HTTP request failed');
    res.status(err.status ?? 500).json({ error: { code: err.code ?? 'INTERNAL_ERROR', message: err.status ? err.message : 'Internal server error' } });
  });
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  return app;
}

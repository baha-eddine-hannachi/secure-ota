import { timingSafeEqual } from 'node:crypto';

export function createAdminAuth(expectedToken, events) {
  return async (req, res, next) => {
    const supplied = req.get('authorization')?.startsWith('Bearer ') ? req.get('authorization').slice(7) : '';
    const a = Buffer.from(supplied); const b = Buffer.from(expectedToken);
    // Constant-time comparison is used for equal-length tokens to avoid timing leaks.
    const valid = a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
    if (!valid) {
      try { await events.record({ type: 'auth_failure', severity: 'warning', details: { route: req.path, method: req.method } }); }
      catch (error) { return next(error); }
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    next();
  };
}

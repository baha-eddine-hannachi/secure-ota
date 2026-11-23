import { z } from 'zod';

export const statusSchema = z.object({
  request_id: z.uuid(), device_id: z.string().min(1).max(64),
  state: z.enum(['received', 'downloading', 'verifying', 'installing', 'rebooting', 'success', 'failed', 'rolled_back', 'rejected']),
  progress: z.number().int().min(0).max(100), error_code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).optional(),
  version: z.string().max(64).optional(), ts: z.union([z.iso.datetime(), z.number()]).optional(),
}).strict();

export const deviceStatusSchema = z.object({ device_id: z.string().min(1).max(64), target: z.string().optional(), version: z.string().max(64).optional(), state: z.string().optional(), uptime_s: z.number().nonnegative().optional(), min_allowed_version: z.string().max(64).optional(), online: z.boolean().optional(), ts: z.union([z.iso.datetime(), z.number()]).optional() }).passthrough();
export const telemetrySchema = z.object({ device_id: z.string().min(1).max(64), ts: z.iso.datetime().optional() }).passthrough();
export const securityEventSchema = z.object({ device_id: z.string().min(1).max(64), event: z.string().min(1).max(100), severity: z.enum(['info', 'warning', 'error', 'critical']).default('warning'), details: z.record(z.string(), z.unknown()).optional(), ts: z.iso.datetime().optional() }).passthrough();

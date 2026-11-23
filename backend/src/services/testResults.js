import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const testResultSchema = z.object({
  id: z.string().regex(/^T(?:0[1-9]|1[0-4])$/),
  title: z.string().min(1).max(200),
  stage: z.string().min(1).max(20),
  status: z.enum(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED']),
  fw_from: z.string().max(64),
  fw_to: z.string().max(64),
  date: z.iso.datetime(),
  operator: z.string().min(1).max(100),
  summary: z.string().max(500),
  observed: z.array(z.string().max(500)).max(100),
  evidence: z.array(z.string().regex(/^T(?:0[1-9]|1[0-4])-\d+\.txt$/)).max(50),
  notes: z.string().max(4000),
}).strict();

const TEST_ID = /^T(?:0[1-9]|1[0-4])$/;
const EVIDENCE_NAME = /^T(?:0[1-9]|1[0-4])-\d+\.txt$/;
const MAX_EVIDENCE_BYTES = 200 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 1024 * 1024;

export function createTestResultsService(reportsDir) {
  const root = path.resolve(reportsDir);
  const resultsDir = path.join(root, 'results');
  const evidenceDir = path.join(root, 'evidence');

  async function readOne(id, { includeEvidence = false } = {}) {
    if (!TEST_ID.test(id)) throw Object.assign(new Error('Invalid test id'), { code: 'INVALID_TEST_ID', status: 400 });
    const file = path.join(resultsDir, `${id}.json`);
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Object.assign(new Error('Test result is invalid'), { code: 'INVALID_TEST_RESULT', status: 500 });
    }
    const parsed = testResultSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== id) throw Object.assign(new Error('Test result is invalid'), { code: 'INVALID_TEST_RESULT', status: 500 });
    if (!includeEvidence) return parsed.data;

    const evidence = [];
    let totalBytes = 0;
    const allowedRoot = await realpath(evidenceDir).catch(() => null);
    for (const filename of parsed.data.evidence) {
      if (!EVIDENCE_NAME.test(filename) || !allowedRoot) throw Object.assign(new Error('Evidence unavailable'), { code: 'EVIDENCE_UNAVAILABLE', status: 404 });
      const candidate = path.resolve(evidenceDir, filename);
      let actual;
      try { actual = await realpath(candidate); }
      catch { throw Object.assign(new Error('Evidence unavailable'), { code: 'EVIDENCE_UNAVAILABLE', status: 404 }); }
      const relative = path.relative(allowedRoot, actual);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('Evidence unavailable'), { code: 'EVIDENCE_UNAVAILABLE', status: 404 });
      const info = await stat(actual);
      totalBytes += info.size;
      if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES || totalBytes > MAX_TOTAL_EVIDENCE_BYTES) throw Object.assign(new Error('Evidence size limit exceeded'), { code: 'EVIDENCE_TOO_LARGE', status: 413 });
      evidence.push({ filename, text: await readFile(actual, 'utf8') });
    }
    return { ...parsed.data, evidence };
  }

  return {
    async list() {
      let names;
      try { names = await readdir(resultsDir); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const results = [];
      for (const name of names.filter((value) => /^T(?:0[1-9]|1[0-4])\.json$/.test(value)).sort()) {
        const result = await readOne(name.slice(0, -5));
        if (result) results.push(result);
      }
      return results;
    },
    get: (id, options) => readOne(id, options),
    async readReportHtml() {
      const file = path.join(root, 'OTA_TEST_REPORT.html');
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Object.assign(new Error('Report unavailable'), { code: 'REPORT_UNAVAILABLE', status: 404 });
        return await readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') throw Object.assign(new Error('Report not found'), { code: 'REPORT_NOT_FOUND', status: 404 });
        throw error;
      }
    },
  };
}

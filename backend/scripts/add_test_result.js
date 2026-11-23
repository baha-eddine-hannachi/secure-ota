import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { TEST_BY_ID } from './test-cases.js';
import { testResultSchema } from '../src/services/testResults.js';

const MAX_BYTES = 200 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));
const reports = path.resolve(process.env.OTA_REPORTS_DIR ?? path.join(here, '..', 'reports'));

function argumentsMap(argv) {
  const values = new Map();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg.split('=')[0]}`);
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    const value = eq < 0 ? '' : arg.slice(eq + 1);
    if (key === 'evidence' || key === 'observed') values.set(key, [...(values.get(key) ?? []), value]);
    else values.set(key, value);
  }
  return values;
}

function required(args, key) {
  const value = args.get(key);
  if (typeof value !== 'string' || !value) throw new Error(`Missing --${key}=...`);
  return value;
}

function evidenceSourceAllowed(filename) {
  const resolved = path.resolve(filename);
  const pieces = resolved.split(/[\\/]+/).map((part) => part.toLowerCase());
  const base = path.basename(resolved).toLowerCase();
  return !pieces.some((part) => part === 'data' || part === 'certs' || part === '.iot-keys' || part === 'keys')
    && !/^\.env(?:\.|$)/i.test(base)
    && !/\.(?:pem|key|p12|pfx)$/i.test(base);
}

function maskEvidence(input) {
  let text = input;
  const warnings = [];
  let pemCount = 0;
  text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, () => { pemCount++; return '[REDACTED PRIVATE KEY BLOCK]'; });
  if (pemCount) warnings.push(`${pemCount} bloc(s) de clé privée PEM masqué(s)`);

  let keyValueCount = 0;
  text = text.replace(/(\bkey\b\s*[:=]\s*)(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{32,}={0,2})/gi, (_m, prefix) => { keyValueCount++; return `${prefix}[REDACTED KEY MATERIAL]`; });
  if (keyValueCount) warnings.push(`${keyValueCount} valeur(s) longue(s) après key masquée(s)`);

  const lines = text.split(/(?<=\n)/);
  let sensitiveLines = 0;
  const masked = lines.map((line) => {
    if (/password|passwd|token|authorization|bearer|WIFI_PASS/i.test(line)) { sensitiveLines++; return '[REDACTED SENSITIVE LINE]\n'; }
    return line;
  }).join('');
  if (sensitiveLines) warnings.push(`${sensitiveLines} ligne(s) contenant un identifiant sensible masquée(s)`);
  return { text: masked, warnings };
}

const args = argumentsMap(process.argv.slice(2));
const id = required(args, 'id');
const definition = TEST_BY_ID.get(id);
if (!definition) throw new Error('--id must be one of T01..T14');
const statusValue = required(args, 'status');
if (!['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED'].includes(statusValue)) throw new Error('Invalid --status');
const evidenceSources = args.get('evidence') ?? [];
const evidenceDir = path.join(reports, 'evidence');
const resultsDir = path.join(reports, 'results');
await mkdir(evidenceDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });

const evidence = [];
for (let i = 0; i < evidenceSources.length; i++) {
  const source = evidenceSources[i];
  if (!source || !evidenceSourceAllowed(source)) throw new Error('Evidence source is a protected path or key file');
  const info = await stat(source);
  if (!info.isFile()) throw new Error('Evidence source must be a regular file');
  if (info.size > MAX_BYTES) throw new Error('Evidence files must be 200 KB or smaller');
  const bytes = await readFile(source);
  if (bytes.some((byte) => byte === 0 || (byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)))) throw new Error('Binary evidence files are not accepted');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Evidence file must be valid UTF-8 text'); }
  const result = maskEvidence(text);
  const filename = `${id}-${i + 1}.txt`;
  await writeFile(path.join(evidenceDir, filename), result.text, { encoding: 'utf8', mode: 0o600 });
  evidence.push(filename);
  for (const warning of result.warnings) process.stderr.write(`Warning: ${filename}: ${warning}.\n`);
}

const result = {
  id,
  title: definition.title,
  stage: definition.stage,
  status: statusValue,
  fw_from: args.get('fw-from') ?? '',
  fw_to: args.get('fw-to') ?? '',
  date: new Date().toISOString(),
  operator: args.get('operator') ?? process.env.USERNAME ?? 'local-operator',
  summary: required(args, 'summary'),
  observed: args.get('observed') ?? [],
  evidence,
  notes: args.get('notes') ?? '',
};
const parsed = testResultSchema.safeParse(result);
if (!parsed.success) throw new Error(`Invalid result: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
await writeFile(path.join(resultsDir, `${id}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`Recorded ${id} as ${statusValue}; evidence files: ${evidence.length}.\n`);

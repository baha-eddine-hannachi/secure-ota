import { createHash, verify } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { compareSemver, parseSemver } from '../utils/semver.js';

const manifestSchema = z.object({
  device_type: z.enum(['esp32', 'stm32']), version: z.string().max(64), min_version: z.string().max(64),
  size: z.number().int().positive().max(100 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(1).max(1024), signature_alg: z.literal('ECDSA-P256-SHA256-P1363'), encrypted: z.boolean().default(false),
  enc: z.object({ alg: z.literal('AES-256-GCM'), iv: z.string(), tag: z.string(), key_id: z.string().max(64) }).optional(),
  url: z.url().max(2048).refine((value) => new URL(value).protocol === 'https:', 'Firmware URL must use HTTPS'), issued_at: z.iso.datetime(),
}).strict().superRefine((m, ctx) => { try { parseSemver(m.version); parseSemver(m.min_version); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid semantic version', path: ['version'] }); } if (m.encrypted && !m.enc) ctx.addIssue({ code: 'custom', message: 'Encryption metadata required', path: ['enc'] }); });

export function createFirmwaresService({ store, firmwareDir, firmwareSourceDir = path.resolve(process.cwd(), '../release'), firmwareBaseUrl = process.env.FIRMWARE_BASE_URL ?? 'https://localhost:8443', publicKeyPath, events }) {
  async function scanReleases() {
    const results = [];
    let entries;
    try {
      const sourceRoot = await lstat(firmwareSourceDir);
      if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink()) throw new Error('source_root_not_regular');
      entries = await readdir(firmwareSourceDir, { withFileTypes: true });
    }
    catch { throw Object.assign(new Error('Firmware source folder is unavailable'), { code: 'FIRMWARE_SOURCE_UNAVAILABLE', status: 400 }); }
    for (const entry of entries) {
      let version;
      try { parseSemver(entry.name); version = entry.name; } catch { continue; }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const releaseDir = path.join(firmwareSourceDir, version);
      try {
        const folderStat = await lstat(releaseDir);
        if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw new Error('symlink_release');
        const manifestPath = path.join(releaseDir, 'manifest.json'); const firmwarePath = path.join(releaseDir, 'firmware.bin');
        const [manifestStat, firmwareStat] = await Promise.all([lstat(manifestPath), lstat(firmwarePath)]);
        if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || !firmwareStat.isFile() || firmwareStat.isSymbolicLink()) throw new Error('symlink_or_non_regular_file');
        if (manifestStat.size > 32 * 1024 || firmwareStat.size > 100 * 1024 * 1024 || firmwareStat.size === 0) throw new Error('release_file_size_invalid');
        const raw = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw);
        if (manifest.version !== version) throw Object.assign(new Error('manifest_version_mismatch'), { code: 'INVALID_MANIFEST' });
        const id = `${manifest.device_type}:${version}`; const old = store.get('firmwares', id);
        const firmware = await this.register({ manifest, firmwarePath });
        if (old) {
          results.push({ version, result: 'already_registered' });
        } else {
          await events.record({ type: 'firmware_release_scanned', severity: 'info', details: { version, device_type: firmware.device_type } });
          results.push({ version, result: 'registered' });
        }
      } catch (error) {
        const code = error.code ?? (error.message === 'Unexpected end of JSON input' ? 'INVALID_MANIFEST' : 'INVALID_RELEASE');
        await events.record({ type: 'firmware_release_scan_rejected', severity: 'warning', details: { version, error_code: code } });
        results.push({ version, result: 'rejected', error_code: code });
      }
    }
    return results;
  }
  async function resolveSourceFile(value, firmwareSourceDir) {
    const reject = async (reason) => {
      await events.record({ type: 'firmware_path_rejected', severity: 'warning', details: { reason } });
      throw Object.assign(new Error('Invalid firmware path'), { code: 'INVALID_FIRMWARE_PATH', status: 400 });
    };
    if (typeof value !== 'string' || value.includes('\0')) return reject('invalid_path_string');
    const windowsPath = value.replaceAll('/', '\\');
    const basename = path.win32.basename(windowsPath).replace(/[ .]+$/, '');
    const deviceStem = basename.split('.')[0].replace(/[ .]+$/, '');
    if (windowsPath.startsWith('\\\\') || /^\/[\/]/.test(value)) return reject('unc_path');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceStem)) return reject('device_name');
    try {
      const allowedRoot = await realpath(firmwareSourceDir);
      const resolved = path.resolve(value);
      const actual = await realpath(resolved);
      const relative = path.relative(allowedRoot, actual);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return reject('outside_source_directory');
      const info = await stat(actual);
      if (!info.isFile()) return reject('not_regular_file');
      return { file: actual, info };
    } catch (error) {
      if (error.code === 'INVALID_FIRMWARE_PATH') throw error;
      return reject('unavailable_path');
    }
  }
  return {
    list: () => store.list('firmwares'),
    scanReleases,
    async register({ manifest: rawManifest, firmwarePath }) {
      const parsed = manifestSchema.safeParse(rawManifest);
      if (!parsed.success) { await events.record({ type: 'firmware_manifest_invalid', severity: 'error', details: { issues: parsed.error.issues.map((i) => i.path.join('.')) } }); throw Object.assign(new Error('Malformed firmware manifest'), { code: 'INVALID_MANIFEST', status: 400 }); }
      const manifest = parsed.data;
      if (compareSemver(manifest.min_version, manifest.version) > 0) {
        await events.record({ type: 'firmware_manifest_invalid', severity: 'error', details: { version: manifest.version, min_version: manifest.min_version, reason: 'minimum_version_exceeds_version' } });
        throw Object.assign(new Error('Malformed firmware manifest'), { code: 'INVALID_MANIFEST', status: 400 });
      }
      try { if (!publicKeyPath) throw new Error('Signing public key not configured');
        const key = await readFile(publicKeyPath);
        const signature = Buffer.from(manifest.signature, 'base64');
        if (signature.length !== 64 || signature.toString('base64') !== manifest.signature) throw new Error('Signature encoding invalid');
        const signedMessage = `IOTFW1|${manifest.device_type}|${manifest.version}|${manifest.min_version}|${manifest.size}|${manifest.sha256}|${manifest.encrypted ? '1' : '0'}`;
        // Registration fails closed unless the signature verifies against the configured public key.
        if (!verify('sha256', Buffer.from(signedMessage, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature)) throw new Error('Signature invalid');
      } catch {
        await events.record({ type: 'firmware_signature_rejected', severity: 'error', details: { version: manifest.version, device_type: manifest.device_type } });
        throw Object.assign(new Error('Firmware signature verification failed'), { code: 'INVALID_SIGNATURE', status: 400 });
      }
      const { file: sourceFile, info: fileStat } = await resolveSourceFile(firmwarePath, firmwareSourceDir);
      let sourceBytes;
      try { sourceBytes = await readFile(sourceFile); }
      catch { throw Object.assign(new Error('Invalid firmware path'), { code: 'INVALID_FIRMWARE_PATH', status: 400 }); }
      const digest = createHash('sha256').update(sourceBytes).digest('hex');
      if (!fileStat.isFile() || fileStat.size !== manifest.size || sourceBytes.length !== manifest.size || digest.toLowerCase() !== manifest.sha256.toLowerCase()) {
        await events.record({ type: 'firmware_hash_invalid', severity: 'error', details: { version: manifest.version, expected_size: manifest.size, actual_size: sourceBytes.length } });
        throw Object.assign(new Error('Firmware size or SHA-256 mismatch'), { code: 'INVALID_FIRMWARE_HASH', status: 400 });
      }
      const id = `${manifest.device_type}:${manifest.version}`;
      const existing = store.get('firmwares', id);
      if (existing) {
        if (existing.sha256 === manifest.sha256 && existing.size === manifest.size) return existing;
        await events.record({ type: 'firmware_release_replace_attempt', severity: 'warning', details: { version: manifest.version, device_type: manifest.device_type } });
        throw Object.assign(new Error('Firmware version is already registered'), { code: 'FIRMWARE_VERSION_EXISTS', status: 409 });
      }
      const destinationDir = path.join(firmwareDir, manifest.device_type, manifest.version);
      await mkdir(destinationDir, { recursive: true });
      const destination = path.join(firmwareDir, manifest.device_type, manifest.version, 'firmware.bin');
      const storedManifest = { ...manifest, url: `${firmwareBaseUrl}/firmware/${manifest.device_type}/${manifest.version}/manifest.json`, firmware_url: `${firmwareBaseUrl}/firmware/${manifest.device_type}/${manifest.version}/firmware.bin` };
      const tempBinary = `${destination}.${randomUUID()}.tmp`;
      const manifestPath = path.join(destinationDir, 'manifest.json');
      const tempManifest = `${manifestPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempBinary, sourceBytes, { mode: 0o600, flag: 'wx' });
        await writeFile(tempManifest, JSON.stringify(storedManifest, null, 2), { mode: 0o600, flag: 'wx' });
        await rename(tempBinary, destination);
        await rename(tempManifest, manifestPath);
      } finally {
        await Promise.all([rm(tempBinary, { force: true }), rm(tempManifest, { force: true })]);
      }
      return store.put('firmwares', id, { id, ...storedManifest, firmware_path: destination, registered_at: new Date().toISOString() });
    },
  };
}

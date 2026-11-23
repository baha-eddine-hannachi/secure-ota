import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY = { devices: {}, firmwares: {}, updates: {}, events: [], telemetry: [] };

export class JsonStore {
  constructor(filePath) { this.filePath = filePath; this.data = structuredClone(EMPTY); this.writeQueue = Promise.resolve(); }
  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try { this.data = { ...structuredClone(EMPTY), ...JSON.parse(await readFile(this.filePath, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await this.#persist(); }
    return this;
  }
  async #persist() {
    const dir = path.dirname(this.filePath); await mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.filePath);
  }
  async #save() { this.writeQueue = this.writeQueue.then(() => this.#persist()); return this.writeQueue; }
  list(collection) { return structuredClone(Object.values(this.data[collection])); }
  get(collection, id) { const value = this.data[collection][id]; return value ? structuredClone(value) : null; }
  async put(collection, id, value) { this.data[collection][id] = structuredClone(value); await this.#save(); return structuredClone(value); }
  async append(collection, value, limit = 10000) { this.data[collection].push(structuredClone(value)); if (this.data[collection].length > limit) this.data[collection].splice(0, this.data[collection].length - limit); await this.#save(); return structuredClone(value); }
}

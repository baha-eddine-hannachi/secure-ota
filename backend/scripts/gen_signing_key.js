import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const outputArg = args.find((arg) => arg.startsWith('--out='))?.slice(6);
const directory = path.resolve(outputArg ?? path.join(os.homedir(), '.iot-keys'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const privatePath = path.join(directory, 'signing-private.pem'); const publicPath = path.join(directory, 'signing-public.pem');
await writeFile(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
await writeFile(publicPath, publicKey, { mode: 0o644, flag: 'wx' });
process.stdout.write(`Created signing key pair.\nPrivate key: ${privatePath}\nPublic key: ${publicPath}\n`);

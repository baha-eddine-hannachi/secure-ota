import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

const values = Object.fromEntries(fs.readFileSync(path.resolve('.env'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*([^#=]+)=(.*)$/))
  .filter(Boolean)
  .map((match) => [match[1].trim(), match[2].trim().replace(/^['"]|['"]$/g, '')]));
const certificate = new X509Certificate(fs.readFileSync(path.resolve(values.TLS_CERT_PATH)));
console.log(`A3_certificate_san_ip=${certificate.subjectAltName.includes('IP Address:10.210.189.35')}`);

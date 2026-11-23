import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_CASES } from './test-cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const reports = path.resolve(process.env.OTA_REPORTS_DIR ?? path.join(here, '..', 'reports'));
const resultsDir = path.join(reports, 'results');
await mkdir(path.join(reports, 'evidence'), { recursive: true });
await mkdir(path.join(reports, 'tests'), { recursive: true });
await mkdir(resultsDir, { recursive: true });

const date = new Date().toISOString();
for (const test of TEST_CASES) {
  const firstRun = test.id === 'T01';
  const result = {
    id: test.id,
    title: test.title,
    stage: test.stage,
    status: firstRun ? 'PASS' : 'NOT_RUN',
    fw_from: firstRun ? '1.0.0' : '',
    fw_to: firstRun ? '1.2.0' : '',
    date,
    operator: firstRun ? 'User-reported' : 'Not run',
    summary: firstRun ? 'OTA 1.0.0 -> 1.2.0, statuts received..success, démarrage depuis ota_1 à 0x200000, backend affiche 1.2.0.' : 'Test non exécuté; procédure prévue uniquement.',
    observed: firstRun ? ['Statuts signalés: received, downloading, verifying, installing, rebooting, success.', 'Partition signalée: ota_1 à 0x200000.', 'Version backend signalée: 1.2.0.'] : [],
    evidence: [],
    notes: firstRun ? 'Statut PASS rapporté par l’utilisateur dans le contexte projet; les logs moniteur d’origine ne sont pas joints et le résultat n’a pas été vérifié indépendamment. La date est celle de création de cet enregistrement, pas une date d’exécution vérifiée.' : 'NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.',
  };
  await writeFile(path.join(resultsDir, `${test.id}.json`), `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
process.stdout.write(`Seeded ${TEST_CASES.length} test result records in reports/results.\n`);

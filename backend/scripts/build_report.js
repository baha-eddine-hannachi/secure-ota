import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_CASES } from './test-cases.js';
import { testResultSchema } from '../src/services/testResults.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = path.resolve(process.env.OTA_REPORTS_DIR ?? path.join(root, 'reports'));
const resultsDir = path.join(reports, 'results');
const testsDir = path.join(reports, 'tests');
await mkdir(testsDir, { recursive: true });

const results = new Map();
for (const test of TEST_CASES) {
  const raw = JSON.parse(await readFile(path.join(resultsDir, `${test.id}.json`), 'utf8'));
  const parsed = testResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== test.id) throw new Error(`Invalid result store for ${test.id}`);
  results.set(test.id, parsed.data);
}
const date = new Date().toISOString();
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const mdCell = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
const listMd = (items) => items.length ? items.map((item) => `- ${mdCell(item)}`).join('\n') : '- Aucun résultat observé.';
const statusLabel = (result) => result.id === 'T01' && result.status === 'PASS' ? 'PASS (déclaré par l’utilisateur, non vérifié ici)' : result.status;

const md = [
  '# Rapport de campagne OTA et sécurité',
  '',
  `- Généré le : ${date}`,
  '- Projet : Backend Node.js, Mosquitto et firmware ESP32 OTA',
  '- Versions rapportées : ESP32 1.0.0 → 1.2.0 (T01); prochaine version de test à choisir avant toute campagne matérielle.',
  '- Architecture : ESP32-D0WD-V3, flash 4 Mo, partitions OTA ota_0 à 0x20000 et ota_1 à 0x200000 (0x1E0000 chacune); ESP-IDF 6.1; Mosquitto 2.0.x; Node.js 24.13.0; réseau hotspot IPv4 (10.72.218.x).',
  '',
  '## Objectif',
  '',
  'Suivre les essais de mise à jour sécurisée, les protections backend et les étapes matérielles qui restent à démontrer. Les états non exécutés restent NOT_RUN; les résultats rapportés mais sans logs joints sont signalés comme tels.',
  '',
  '## Architecture',
  '',
  '```text',
  'ESP32 (Wi-Fi; TLS/CA embarquée)',
  '  ├─ MQTT/TLS 1.2+ : Mosquitto :8883 (authentification + ACL)',
  '  └─ HTTPS/TLS 1.2+ : Backend :8443 (API + firmware signé)',
  'Backend ── JSON store local + rapports de tests + dashboard HTTPS',
  '```',
  '',
  '## Résumé des tests',
  '',
  '| ID | Test | Étape | Statut | Firmware | Observé |',
  '|---|---|---|---|---|---|',
  ...TEST_CASES.map((test) => { const r = results.get(test.id); return `| ${test.id} | ${mdCell(test.title)} | ${mdCell(test.stage)} | ${mdCell(statusLabel(r))} | ${mdCell(`${r.fw_from || '—'} → ${r.fw_to || '—'}`)} | ${mdCell(r.summary)} |`; }),
  '',
];

for (const test of TEST_CASES) {
  const r = results.get(test.id);
  const procedure = test.procedure.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const section = [
    `## ${test.id} — ${test.title}`,
    '',
    `- Objectif : ${test.objective}`,
    `- Préconditions : ${test.preconditions}`,
    '- Procédure exacte :',
    procedure,
    `- Résultat attendu : ${test.expected}`,
    '- Résultat observé :',
    listMd(r.observed),
    `- Résumé enregistré : ${mdCell(r.summary)}`,
    `- Verdict : ${statusLabel(r)}`,
    `- Versions firmware : ${mdCell(r.fw_from || '—')} → ${mdCell(r.fw_to || '—')}`,
    `- Date d’enregistrement : ${r.date}`,
    `- Opérateur : ${mdCell(r.operator)}`,
    `- Preuves : ${r.evidence.length ? r.evidence.map((name) => `reports/evidence/${name}`).join(', ') : 'Aucune preuve jointe.'}`,
    `- Notes : ${mdCell(r.notes || 'Aucune.')}`,
    `- Propriété de sécurité : ${test.security}`,
    '',
  ];
  md.push(...section);
  const testMd = [
    `# ${test.id} — ${test.title}`, '', `- Étape : ${test.stage}`, `- Statut : ${statusLabel(r)}`, `- Versions : ${mdCell(r.fw_from || '—')} → ${mdCell(r.fw_to || '—')}`, `- Date : ${r.date}`, '',
    `## Objectif\n\n${test.objective}`, `## Préconditions\n\n${test.preconditions}`, `## Procédure exacte\n\n${procedure}`, `## Résultat attendu\n\n${test.expected}`, `## Résultat observé\n\n${listMd(r.observed)}`, `## Résumé\n\n${mdCell(r.summary)}`, `## Preuves\n\n${r.evidence.length ? r.evidence.map((name) => `- ../evidence/${name}`).join('\n') : 'Aucune preuve jointe.'}`, `## Propriété de sécurité\n\n${test.security}`, `## Notes\n\n${mdCell(r.notes || 'Aucune.')}`, '',
  ].join('\n');
  await writeFile(path.join(testsDir, `${test.id}.md`), testMd, { encoding: 'utf8', mode: 0o600 });
}

const securityProperties = [
  ['Authenticité', ['T04', 'T05']], ['Intégrité', ['T03', 'T04']], ['Fraîcheur / anti-rejeu', ['T07', 'T08']],
  ['Anti-rollback', ['T06']], ['Disponibilité / rollback', ['T02', 'T10', 'T11']], ['Confidentialité', ['T12']], ['Transport sécurisé', ['T13']],
];
md.push('## Synthèse des propriétés de sécurité', '', '| Propriété | Tests associés | État documenté |', '|---|---|---|');
for (const [name, ids] of securityProperties) {
  const states = ids.map((id) => `${id}: ${statusLabel(results.get(id))}`).join('; ');
  md.push(`| ${name} | ${ids.join(', ')} | ${mdCell(states)} |`);
}
md.push('', '## Limites et risques', '', '- Aucun eFuse Secure Boot V2 ni flash encryption n’a été activé dans cette campagne.', '- La clé de signature publique intégrée au firmware est une configuration de développement; la protection de production doit inclure Secure Boot et chiffrement flash.', '- Le firmware est téléchargeable par HTTPS; l’authenticité doit être vérifiée par l’appareil avant installation.', '- Les résultats matériels disponibles sont limités au T01 rapporté par l’utilisateur; les preuves moniteur d’origine ne sont pas jointes ici.', '- Les coupures Wi-Fi/alimentation, replays persistants, firmware chiffré et essais de sécurité matérielle restent à exécuter sur un appareil de test.', '', '## Perspectives', '', '- Relais de mises à jour STM32 après validation du flux ESP32.', '- Secure Boot V2 RSA-3072 et flash encryption en mode développement, selon une procédure séparée et relue.', '- Clés par appareil et provisionnement de production protégé.', '', '---', '', `Rapport généré automatiquement depuis reports/results le ${date}.`, '');
await writeFile(path.join(reports, 'OTA_TEST_REPORT.md'), md.join('\n'), { encoding: 'utf8', mode: 0o600 });

const counts = Object.fromEntries(['PASS', 'FAIL', 'NOT_RUN', 'BLOCKED'].map((status) => [status, TEST_CASES.filter((test) => results.get(test.id).status === status).length]));
const htmlRows = TEST_CASES.map((test) => { const r = results.get(test.id); return `<tr><td>${test.id}</td><td>${escapeHtml(test.title)}</td><td>${escapeHtml(test.stage)}</td><td>${escapeHtml(statusLabel(r))}</td><td>${escapeHtml(r.fw_from || '—')} → ${escapeHtml(r.fw_to || '—')}</td><td>${escapeHtml(r.summary)}</td></tr>`; }).join('\n');
const htmlSections = TEST_CASES.map((test) => { const r = results.get(test.id); const observed = r.observed.length ? `<ul>${r.observed.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>Aucun résultat observé.</p>'; const procedure = `<ol>${test.procedure.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`; return `<section><h2>${test.id} — ${escapeHtml(test.title)}</h2><p><b>Objectif :</b> ${escapeHtml(test.objective)}</p><p><b>Préconditions :</b> ${escapeHtml(test.preconditions)}</p><h3>Procédure</h3>${procedure}<p><b>Attendu :</b> ${escapeHtml(test.expected)}</p><h3>Observé</h3>${observed}<p><b>Verdict :</b> ${escapeHtml(statusLabel(r))}</p><p><b>Firmware :</b> ${escapeHtml(r.fw_from || '—')} → ${escapeHtml(r.fw_to || '—')}</p><p><b>Preuves :</b> ${escapeHtml(r.evidence.join(', ') || 'Aucune preuve jointe')}</p><p><b>Notes :</b> ${escapeHtml(r.notes || 'Aucune')}</p><p><b>Propriété :</b> ${escapeHtml(test.security)}</p></section>`; }).join('\n');
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rapport de campagne OTA</title><style>
@page{size:A4;margin:18mm}*{box-sizing:border-box}body{font:11pt/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#17212b;margin:0 auto;max-width:210mm;padding:18mm}h1,h2,h3{line-height:1.2;color:#12304a}h1{font-size:24pt}h2{font-size:16pt;border-bottom:2px solid #cbd9e3;padding-bottom:.25em}h3{font-size:12pt}table{border-collapse:collapse;width:100%;font-size:9pt}th,td{border:1px solid #9aabb8;padding:6px;text-align:left;vertical-align:top}th{background:#e9f1f6}section{break-before:page;page-break-before:always}li{margin:.25em 0}.status{font-weight:700}pre{white-space:pre-wrap}@media screen{body{padding:24px;max-width:1100px;background:#fff}section{border-top:1px solid #ccd5dc;margin-top:32px;padding-top:16px}}@media print{a{color:inherit;text-decoration:none}}
</style></head><body><header><h1>Rapport de campagne OTA et sécurité</h1><p>Généré le ${escapeHtml(date)}</p><p>Projet : Backend Node.js, Mosquitto et firmware ESP32 OTA.</p><p>Architecture : ESP32-D0WD-V3, flash 4 Mo, ESP-IDF 6.1; Mosquitto 2.0.x; backend Node.js HTTPS/MQTT sur réseau hotspot.</p><p>Comptes : PASS ${counts.PASS}, FAIL ${counts.FAIL}, NOT_RUN ${counts.NOT_RUN}, BLOCKED ${counts.BLOCKED}.</p></header><h2>Architecture</h2><pre>ESP32 ── MQTT/TLS ── Mosquitto :8883
ESP32 ── HTTPS/TLS ── Backend :8443 ── JSON store / dashboard</pre><h2>Résumé des tests</h2><table><thead><tr><th>ID</th><th>Test</th><th>Étape</th><th>Statut</th><th>Firmware</th><th>Observé</th></tr></thead><tbody>${htmlRows}</tbody></table>${htmlSections}<section><h2>Synthèse sécurité</h2><ul>${securityProperties.map(([name, ids]) => `<li><b>${escapeHtml(name)} :</b> ${escapeHtml(ids.map((id) => `${id} ${statusLabel(results.get(id))}`).join('; '))}</li>`).join('')}</ul><h2>Limites et risques</h2><ul><li>Fonctions eFuse Secure Boot V2 et flash encryption non activées.</li><li>Clé publique intégrée au firmware en développement; une chaîne de production doit la protéger.</li><li>Téléchargement firmware accessible sur HTTPS, avec vérification applicative requise.</li><li>Un seul appareil et un seul T01 rapporté; preuves moniteur non jointes.</li><li>T02–T14 non exécutés dans la campagne documentée.</li></ul><h2>Perspectives</h2><p>Relais STM32, Secure Boot V2, flash encryption et clés par appareil.</p></section></body></html>`;
await writeFile(path.join(reports, 'OTA_TEST_REPORT.html'), html, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`Generated Markdown and HTML reports plus ${TEST_CASES.length} test procedures.\n`);

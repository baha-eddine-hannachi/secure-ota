# Rapport de campagne OTA et sécurité

- Généré le : 2026-11-18T11:14:00.989Z
- Projet : Backend Node.js, Mosquitto et firmware ESP32 OTA
- Versions rapportées : ESP32 1.0.0 → 1.2.0 (T01); prochaine version de test à choisir avant toute campagne matérielle.
- Architecture : ESP32-D0WD-V3, flash 4 Mo, partitions OTA ota_0 à 0x20000 et ota_1 à 0x200000 (0x1E0000 chacune); ESP-IDF 6.1; Mosquitto 2.0.x; Node.js 24.13.0; réseau hotspot IPv4 (10.72.218.x).

## Objectif

Suivre les essais de mise à jour sécurisée, les protections backend et les étapes matérielles qui restent à démontrer. Les états non exécutés restent NOT_RUN; les résultats rapportés mais sans logs joints sont signalés comme tels.

## Architecture

```text
ESP32 (Wi-Fi; TLS/CA embarquée)
  ├─ MQTT/TLS 1.2+ : Mosquitto :8883 (authentification + ACL)
  └─ HTTPS/TLS 1.2+ : Backend :8443 (API + firmware signé)
Backend ── JSON store local + rapports de tests + dashboard HTTPS
```

## Résumé des tests

| ID | Test | Étape | Statut | Firmware | Observé |
|---|---|---|---|---|---|
| T01 | Mise à jour OTA nominale 1.0.0 → 1.2.0 | 1 | PASS (déclaré par l’utilisateur, non vérifié ici) | 1.0.0 → 1.2.0 | OTA 1.0.0 -&gt; 1.2.0, statuts received..success, démarrage depuis ota_1 à 0x200000, backend affiche 1.2.0. |
| T02 | Rollback après absence de confirmation | 1 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T03 | Firmware modifié après enregistrement | 2 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T04 | Manifeste modifié après signature | 2 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T05 | Mauvaise signature et algorithme incorrect | 2 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T06 | Version identique ou antérieure | 1/2 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T07 | Commande expirée ou horodatage invalide | 1 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T08 | Réutilisation du request_id après redémarrage | 2 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T09 | URL ou cible non fiable | 1 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T10 | Coupure Wi-Fi pendant téléchargement | 1/2 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T11 | Coupure d’alimentation pendant OTA et après redémarrage | 1/2 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T12 | Firmware chiffré AES-256-GCM | 3 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |
| T13 | Sécurité du backend et API | backend | PASS | — → — | Backend suite: 31/31 passed; dependency audit: 0 vulnerabilities; isolated QA: 33 assertions passed; ESP-IDF firmware build completed. Live TLS negotiation, MQTT with a test account, and targeted live rate-limit exercise were not run. |
| T14 | Secure Boot V2 et flash encryption | 4 | NOT_RUN | — → — | Test non exécuté; procédure prévue uniquement. |

## T01 — Mise à jour OTA nominale 1.0.0 → 1.2.0

- Objectif : Démontrer un parcours OTA nominal de bout en bout.
- Préconditions : ESP32 en 1.0.0, backend/MQTT opérationnels, version 1.2.0 enregistrée et commande autorisée.
- Procédure exacte :
1. Consulter le moniteur série et confirmer la version 1.0.0.
2. Depuis backend, lancer .\ota.ps1 -Version 1.2.0 avec la clé de signature appropriée (ne pas inclure de secret dans le rapport).
3. Observer les états MQTT et le redémarrage du périphérique.
4. Vérifier la partition active et la version publiée au backend.
- Résultat attendu : États reçus dans l’ordre jusqu’à success; démarrage sur ota_1 (0x200000); version backend 1.2.0.
- Résultat observé :
- Statuts signalés: received, downloading, verifying, installing, rebooting, success.
- Partition signalée: ota_1 à 0x200000.
- Version backend signalée: 1.2.0.
- Résumé enregistré : OTA 1.0.0 -&gt; 1.2.0, statuts received..success, démarrage depuis ota_1 à 0x200000, backend affiche 1.2.0.
- Verdict : PASS (déclaré par l’utilisateur, non vérifié ici)
- Versions firmware : 1.0.0 → 1.2.0
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : User-reported
- Preuves : Aucune preuve jointe.
- Notes : Statut PASS rapporté par l’utilisateur dans le contexte projet; les logs moniteur d’origine ne sont pas joints et le résultat n’a pas été vérifié indépendamment. La date est celle de création de cet enregistrement, pas une date d’exécution vérifiée.
- Propriété de sécurité : Transport TLS, intégrité du parcours, confirmation d’image et retour d’état.

## T02 — Rollback après absence de confirmation

- Objectif : Vérifier que le nouveau firmware non confirmé ne devient pas permanent.
- Préconditions : Rollback applicatif activé et firmware de test compilé avec SIMULATE_BAD_FIRMWARE=1.
- Procédure exacte :
1. Construire le firmware de test.
2. Utiliser une nouvelle version et démarrer une mise à jour contrôlée.
3. Observer le délai de santé puis le redémarrage de rollback.
4. Confirmer version précédente et état rolled_back.
- Résultat attendu : Retour à l’image précédente; état rolled_back / new_app_not_confirmed.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Disponibilité et récupération après démarrage défaillant.

## T03 — Firmware modifié après enregistrement

- Objectif : Démontrer que les octets téléchargés sont comparés au digest signé avant le changement de slot.
- Préconditions : Firmware enregistré, copie de test isolée et mécanisme de modification contrôlé.
- Procédure exacte :
1. Enregistrer une nouvelle version.
2. Dans un environnement isolé, modifier un octet du fichier servi après enregistrement.
3. Déclencher la procédure de test autorisée.
4. Vérifier hash_mismatch et le maintien de l’image précédente.
- Résultat attendu : Échec hash_mismatch; aucune nouvelle partition activée.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Intégrité du firmware avant installation.

## T04 — Manifeste modifié après signature

- Objectif : Vérifier que les champs version et min_version sont protégés par la signature.
- Préconditions : Manifeste signé disponible et copie de test isolée.
- Procédure exacte :
1. Créer une version de test enregistrée.
2. Modifier version ou min_version dans la copie du manifeste servi.
3. Déclencher le test contrôlé.
4. Vérifier le rejet et l’absence de changement de slot.
- Résultat attendu : Rejet signature_invalid; rien installé.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Authenticité des métadonnées du firmware.

## T05 — Mauvaise signature et algorithme incorrect

- Objectif : Vérifier l’échec fermé des signatures non fiables et des algorithmes inattendus.
- Préconditions : Clé de test temporaire distincte; aucun matériau privé réel utilisé.
- Procédure exacte :
1. Signer un manifeste de test avec une clé éphémère distincte.
2. Essayer séparément un manifeste avec signature_alg incorrect.
3. Soumettre uniquement dans l’environnement isolé.
4. Vérifier le rejet des deux variantes.
- Résultat attendu : Rejet de la signature ou de signature_alg; rien installé.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Authenticité et choix explicite de l’algorithme.

## T06 — Version identique ou antérieure

- Objectif : Empêcher une réinstallation ou un retour à une version déjà signalée.
- Préconditions : Version courante connue et requêtes de test sans déclenchement d’une mise à jour réelle.
- Procédure exacte :
1. Demander la version courante.
2. Demander une version plus ancienne.
3. Vérifier le refus et l’événement de sécurité pour chacune.
- Résultat attendu : Refus VERSION_NOT_NEWER côté backend ou version_not_newer côté appareil.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Anti-rollback logiciel.

## T07 — Commande expirée ou horodatage invalide

- Objectif : Vérifier les limites de fraîcheur des commandes.
- Préconditions : Compte de test et publication de test autorisés par l’ACL.
- Procédure exacte :
1. Préparer des commandes isolées avec expiration passée, émission future, puis TTL supérieur à une heure.
2. Publier uniquement avec l’utilisateur de test autorisé.
3. Vérifier le code de rejet de chaque commande.
- Résultat attendu : Rejets command_expired, issued_in_future ou ttl_too_long selon le cas.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Fraîcheur et fenêtre temporelle bornée.

## T08 — Réutilisation du request_id après redémarrage

- Objectif : Vérifier la persistance de la protection anti-rejeu.
- Préconditions : request_id contrôlé et image de test; procédure avec redémarrage autorisée.
- Procédure exacte :
1. Envoyer une demande de test avec un identifiant unique.
2. Redémarrer selon la procédure sûre.
3. Renvoyer le même request_id.
4. Vérifier le rejet persistant et l’absence de seconde installation.
- Résultat attendu : Rejeu rejeté; aucune seconde installation.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Anti-rejeu persistante.

## T09 — URL ou cible non fiable

- Objectif : Vérifier le préfixe HTTPS de confiance et l’identité device/target.
- Préconditions : Commandes de test isolées et observation réseau autorisée.
- Procédure exacte :
1. Essayer http://, un autre hôte, un chemin avec .., un mauvais device_id et une mauvaise target.
2. Vérifier chaque rejet avant téléchargement.
3. Confirmer qu’aucun firmware n’a été écrit.
- Résultat attendu : Rejet avant tout téléchargement.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Réduction de la surface réseau et liaison à la cible.

## T10 — Coupure Wi-Fi pendant téléchargement

- Objectif : Vérifier la gestion d’une perte réseau transitoire.
- Préconditions : Périphérique de test, image précédente fonctionnelle et fenêtre de maintenance.
- Procédure exacte :
1. Démarrer une mise à jour de test.
2. Couper le Wi-Fi pendant le transfert.
3. Observer l’état final et redémarrer normalement.
4. Confirmer que l’image précédente reste active.
- Résultat attendu : État failed avec erreur réseau; ancienne image toujours démarrable.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Disponibilité et écriture OTA interrompue en sécurité.

## T11 — Coupure d’alimentation pendant OTA et après redémarrage

- Objectif : Évaluer la récupération après coupure d’alimentation.
- Préconditions : Carte de test non critique, alimentation contrôlée et procédure de récupération disponible.
- Procédure exacte :
1. Interrompre l’alimentation pendant un transfert de test.
2. Redémarrer et relever l’image active.
3. Répéter une coupure après le redémarrage OTA.
4. Confirmer que le bootloader sélectionne une image valide.
- Résultat attendu : Le périphérique démarre une image valide après chaque interruption.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Résilience aux interruptions d’alimentation.

## T12 — Firmware chiffré AES-256-GCM

- Objectif : Vérifier l’authentification AEAD et l’intégrité du fichier chiffré.
- Préconditions : Clé de développement isolée, versions distinctes et matériel de test.
- Procédure exacte :
1. Tester un paquet chiffré nominal.
2. Tester une mauvaise clé.
3. Altérer un octet du texte chiffré.
4. Tronquer le fichier puis vérifier le rejet de chaque variante.
- Résultat attendu : Nominal installé; mauvaise clé, octet altéré et fichier tronqué refusés.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Confidentialité de développement et authenticité AES-GCM.

## T13 — Sécurité du backend et API

- Objectif : Vérifier authentification, TLS, validation, serving firmware et limitation de débit.
- Préconditions : Backend de test, CA publique et données temporaires; aucun secret réel dans les preuves.
- Procédure exacte :
1. Lancer npm test et npm audit.
2. Vérifier les refus d’authentification et la validation des entrées.
3. Tester TLS avec la CA et les contrôles de firmware/range.
4. Tester le rate limit dans un environnement isolé.
- Résultat attendu : Résultats selon qa/QA_REPORT.md et les tests backend actualisés.
- Résultat observé :
- npm test: 31 passed, 0 failed
- npm audit: 0 vulnerabilities
- node qa/isolated_qa.mjs: 33 isolated assertions completed; C5/C6/C7/E1 passed
- idf.py build: completed; wifi_base.bin 0xec5e0 bytes, 51% partition space free
- Résumé enregistré : Backend suite: 31/31 passed; dependency audit: 0 vulnerabilities; isolated QA: 33 assertions passed; ESP-IDF firmware build completed. Live TLS negotiation, MQTT with a test account, and targeted live rate-limit exercise were not run.
- Verdict : PASS
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-18T11:14:00.730Z
- Opérateur : Codex
- Preuves : Aucune preuve jointe.
- Notes : PASS applies to the software checks listed. Live TLS negotiation, live MQTT, and targeted rate-limit checks remain unrun. No real device or external listener was contacted.
- Propriété de sécurité : Contrôle d’accès, transport, validation et disponibilité.

## T14 — Secure Boot V2 et flash encryption

- Objectif : Préparer un plan sûr de provisionnement et de récupération.
- Préconditions : Aucune action eFuse autorisée dans cette campagne.
- Procédure exacte :
1. Lire le plan Stage 4.
2. Effectuer une revue indépendante des préconditions et récupérations avant tout essai futur.
3. Ne pas exécuter de commande de gravure.
- Résultat attendu : NOT_RUN: procédure documentée seulement; aucun eFuse ni chiffrement activé.
- Résultat observé :
- Aucun résultat observé.
- Résumé enregistré : Test non exécuté; procédure prévue uniquement.
- Verdict : NOT_RUN
- Versions firmware : — → —
- Date d’enregistrement : 2026-11-11T19:24:14.280Z
- Opérateur : Not run
- Preuves : Aucune preuve jointe.
- Notes : NOT_RUN: aucun résultat n’a été inventé. La date correspond à la création de l’enregistrement.
- Propriété de sécurité : Perspectives de chaîne de confiance matérielle.

## Synthèse des propriétés de sécurité

| Propriété | Tests associés | État documenté |
|---|---|---|
| Authenticité | T04, T05 | T04: NOT_RUN; T05: NOT_RUN |
| Intégrité | T03, T04 | T03: NOT_RUN; T04: NOT_RUN |
| Fraîcheur / anti-rejeu | T07, T08 | T07: NOT_RUN; T08: NOT_RUN |
| Anti-rollback | T06 | T06: NOT_RUN |
| Disponibilité / rollback | T02, T10, T11 | T02: NOT_RUN; T10: NOT_RUN; T11: NOT_RUN |
| Confidentialité | T12 | T12: NOT_RUN |
| Transport sécurisé | T13 | T13: PASS |

## Limites et risques

- Aucun eFuse Secure Boot V2 ni flash encryption n’a été activé dans cette campagne.
- La clé de signature publique intégrée au firmware est une configuration de développement; la protection de production doit inclure Secure Boot et chiffrement flash.
- Le firmware est téléchargeable par HTTPS; l’authenticité doit être vérifiée par l’appareil avant installation.
- Les résultats matériels disponibles sont limités au T01 rapporté par l’utilisateur; les preuves moniteur d’origine ne sont pas jointes ici.
- Les coupures Wi-Fi/alimentation, replays persistants, firmware chiffré et essais de sécurité matérielle restent à exécuter sur un appareil de test.

## Perspectives

- Relais de mises à jour STM32 après validation du flux ESP32.
- Secure Boot V2 RSA-3072 et flash encryption en mode développement, selon une procédure séparée et relue.
- Clés par appareil et provisionnement de production protégé.

---

Rapport généré automatiquement depuis reports/results le 2026-11-18T11:14:00.989Z.

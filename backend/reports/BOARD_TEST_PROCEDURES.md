# Procédure de validation sur carte — T02 à T09

**Ne pas exécuter pendant la présente revue.** Ces scénarios déclenchent des commandes OTA. Les exécuter uniquement après autorisation, sur une carte de réserve, un broker de test et un backend dont le répertoire de données/firmwares est temporaire. Ne jamais viser le backend opérationnel, son `data/`, ou son ESP32 actuel. L’agent n’a flashé ni contacté la carte et n’a lancé aucune de ces procédures.

## Préparation commune

- Ouvrir le moniteur série de la carte de réserve et noter la version et la partition actives.
- Démarrer un backend et Mosquitto dédiés au test, configurés avec répertoires temporaires, compte MQTT de test, utilisateur API de test, CA de test et certificats de test. Garder TLS vérifié.
- Dans une seconde PowerShell, se placer dans `C:\Users\Dell\Documents\iot\backend`. Remplacer `<VERSION_UNIQUE>` par une version strictement nouvelle à chaque essai; les versions sont immuables.
- Définir `OTA_ADMIN_TOKEN` dans l’environnement du processus avec le jeton du backend de test (ne pas utiliser le jeton de production). Configurer le backend de test avec `FIRMWARE_SOURCE_DIR` égal au répertoire fourni avec `-ReleaseDir`. Depuis `backend`, la commande d’inscription seule (ne déclenche rien) est `.\ota.ps1 -Version <VERSION_UNIQUE> -NoTrigger -Base https://<HOTE_TEST>:<PORT_TEST> -Ca <CA_TEST_PEM> -ReleaseDir (Join-Path $env:TEMP iot-ota-release-test)`. Le script utilise la clé de signature déjà configurée sur le poste; ne pas la copier dans les commandes, la console ou les preuves. Pour une image spécifique, ajouter `-Bin ..\wifi_base\build-sim-bad\wifi_base.bin`.
- Garder la console MQTT de test abonnée au sujet de statut `iot/stm32/update/status` avec TLS et les identifiants de test autorisés par l’ACL. Ne jamais utiliser de commande qui désactive la validation TLS.
- Contrôler l’état via le dashboard `/dashboard/` sur le backend test. Ne pas saisir ni sauvegarder de jeton dans l’URL.

## T02 — rollback

1. Vérifier que `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` est activé avant le test; ici il ne l’est pas. Il faut l’activer dans menuconfig puis flasher via USB la chaîne bootloader/table/app compatible avant T02.
2. Depuis le terminal ESP-IDF dans `wifi_base`, compiler dans un dossier séparé avec `idf.py -B build-sim-bad -D "CMAKE_C_FLAGS=-DSIMULATE_BAD_FIRMWARE=1" build`. Ce macro empêche le démarrage MQTT dans la nouvelle image; conserver l’image normale pour l’image actuellement démarrée.
3. Enregistrer avec `.\ota.ps1 -Version <VERSION_UNIQUE> -NoTrigger -Bin ..\wifi_base\build-sim-bad\wifi_base.bin` puis après inspection de la carte lancer `.\ota.ps1 -Version <VERSION_UNIQUE> -TriggerOnly -Base https://<HOTE_TEST>:<PORT_TEST> -Ca <CA_TEST_PEM> -ReleaseDir (Join-Path $env:TEMP iot-ota-release-test)`.
4. Attendu au moniteur : `Nouvelle application a valider`, puis `Health check echoue: retour a l'application precedente`. Attendu MQTT: `received`, `downloading`, `verifying`, `installing`, `rebooting`, puis `rolled_back` avec `new_app_not_confirmed`; l’ancienne version redémarre.

## T03 — octet firmware modifié après inscription

1. Inscrire une version dans le serveur isolé et confirmer qu’elle apparaît.
2. Dans le répertoire de firmwares temporaire de ce serveur uniquement, sauvegarder puis altérer un octet de `esp32/<VERSION_UNIQUE>/firmware.bin` après inscription. Ne pas toucher à `backend/data/` du projet.
3. Lancer le test contrôlé avec `-TriggerOnly`. Attendu: état `failed`, `error_code=hash_mismatch`; aucune sélection du nouveau slot et l’image précédente reste active.

## T04 — manifeste modifié après signature

1. Inscrire la version dans le serveur isolé, puis modifier uniquement le `version` (essai 1) ou le `min_version` (essai 2) dans la copie temporaire du `manifest.json` servi; ne pas resign.
2. Déclencher avec `-TriggerOnly`. Attendu: `rejected`, `signature_invalid` (ou `manifest_invalid` si la mutation rend le schéma/semver invalide); pas de téléchargement/install.

## T05 — signature incorrecte / algorithme incorrect

1. Générer une paire de signature éphémère dans un répertoire temporaire, sans utiliser ni lire la vraie clé. Produire une image et un manifeste de test avec le signer, puis le faire servir par le backend isolé configuré avec la clé publique normale.
2. Avec l’image correcte, faire varier ensuite `signature_alg` dans une copie du manifeste. Attendu: manifeste signé par l’autre clé → `rejected/signature_invalid`; algorithme modifié → `rejected/bad_signature_alg`.
3. Ne pas placer la clé privée éphémère dans le dépôt; la supprimer après la session si elle n’est plus nécessaire.

## T06 — version courante ou plus ancienne

- Depuis le dashboard, consulter la version publiée par la carte; tenter la même version puis une version plus ancienne par l’interface de test/API sur le backend isolé. Attendu HTTP 409 `VERSION_NOT_NEWER` et événement de sécurité pour chaque refus; une version supérieure est acceptée mais **ne pas déclencher cette dernière** sans approbation de la session matérielle.

## T07 — timestamps expirés/futurs/TTL trop long

- N’utiliser que le broker de test et un compte MQTT explicitement autorisé pour publier sur le topic de commande. Le broker opérationnel peut refuser ce topic par ACL; ne pas contourner cette ACL.
- Construire un payload JSON de commande avec `request_id` UUID neuf, `device_id`, `target`, `version`, `manifest_url`, `issued_at`, `expires_at`, puis varier successivement: `expires_at` passé, `issued_at` > 5 min dans le futur, et durée > 1 h. Publier depuis le dossier backend test:

```powershell
$payload = '<JSON_DE_COMMANDE_DE_TEST>'
$payload | Set-Content -NoNewline -Encoding utf8 .\command-test.json
mosquitto_pub.exe -h <BROKER_TEST> -p 8883 --cafile <CA_TEST_PEM> -u $env:TEST_MQTT_USERNAME -P $env:TEST_MQTT_PASSWORD -t iot/stm32/update/command -q 1 -f .\command-test.json
Remove-Item -LiteralPath .\command-test.json
```

- Attendu par variation: `command_expired`, `issued_in_future`, puis `ttl_too_long`; vérifier `rejected` sur statut MQTT. Les secrets restent dans les variables d’environnement et ne doivent pas être imprimés; préférer un compte test ACL limité.

## T08 — replay persistant

1. Envoyer une commande valide à la carte de test avec un `request_id` unique et conserver le JSON uniquement dans un fichier temporaire contrôlé.
2. Redémarrer la carte après le premier traitement, republier exactement le même `request_id` sur le broker test.
3. Attendu: `rejected/replayed_request`, pas de seconde installation. Vérifier que le NVS contient toujours les clés OTA et que la version courante est inchangée.

## T09 — URL et identité non fiables

Pour chaque essai, publier un JSON de commande via le broker test avec request_id neuf, en ne changeant qu’un champ: URL `http://`, hôte différent, chemin avec `..`, mauvais `device_id`, puis mauvaise `target`. Attendu: rejet avant accès HTTP/OTA (`untrusted_url`, `wrong_device` ou `wrong_target`); aucune partition écrite et ancienne image active.

Après chaque essai, enregistrer le statut réel via `node scripts/add_test_result.js --id=Txx --status=PASS|FAIL --summary="..." --evidence=<fichier-texte-moniteur>` puis `node scripts/build_report.js`. Un test n’est PASS que si le résultat observé et ses preuves satisfont tous les critères attendus.

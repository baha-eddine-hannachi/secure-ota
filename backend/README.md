# Secure IoT Update Backend

Node.js backend for update orchestration, device supervision, signed firmware registration, and HTTPS delivery. The backend does not authorize firmware execution: each device must independently verify the manifest signature, firmware hash, target, version/anti-rollback policy, expiry, and (when enabled) encryption before installation.

## Requirements

- Node.js 18 or newer and npm.
- Mosquitto reachable at the configured MQTT URL with TLS enabled and a `backend` user permitted to publish `iot/stm32/update/command` and read `iot/#`.
- TLS certificate and key for this backend. The certificate SAN includes `10.210.189.35` (current) and `192.168.0.217` (compatibility), plus localhost entries.
- ECDSA P-256 signing key pair. The private signing key stays outside this repository.

Dependencies are kept small: Express serves the API, MQTT.js connects to Mosquitto, dotenv loads local configuration, Zod validates inputs, Pino logs structured events, Helmet adds HTTP security headers, and express-rate-limit bounds API request rates.

## Install and configure

```powershell
cd C:\Users\Dell\Documents\iot\backend
npm install
Copy-Item .env.example .env
```

Edit `.env` with actual credentials and local certificate paths. Never commit `.env`, key files, firmware data, or credentials. `MQTT_CA_PATH` must point to the public CA certificate. Do not place CA or broker private keys in this project.

Generate a firmware signing key outside the repository (default `%USERPROFILE%\.iot-keys`):

```powershell
node scripts/gen_signing_key.js
```

Set `SIGNING_PUBLIC_KEY_PATH` to the generated public key. Keep `signing-private.pem` protected and out of the repository. Start the service with:

```powershell
npm start
```

The REST API and firmware endpoints use HTTPS on `HTTP_PORT` (default 8443). MQTT uses TLS 1.2 or newer and validates the broker certificate against the configured CA. Startup fails if required configuration, certificates, or the certificate IP SAN are missing. Device status messages populate the device registry; updates are only accepted for known devices.

## Environment variables

| Variable | Purpose |
|---|---|
| `MQTT_URL` | MQTT TLS broker URL |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | Broker credentials |
| `MQTT_CA_PATH` | Public CA certificate used to authenticate Mosquitto |
| `HTTP_PORT` | HTTPS API and firmware port |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | Backend HTTPS certificate and private key |
| `ADMIN_API_TOKEN` | Bearer token for admin routes (minimum 32 characters) |
| `FIRMWARE_DIR` | Storage directory for registered firmware (default `./data/firmware`) |
| `FIRMWARE_SOURCE_DIR` | Allowed source folder for firmware registration (default `../release`, next to the backend folder) |
| `FIRMWARE_BASE_URL` | HTTPS base URL embedded in update commands |
| `COMMAND_TTL_SECONDS` | Command lifetime (30–3600 seconds; default 600) |
| `LOG_LEVEL` | Pino log level |
| `SIGNING_PUBLIC_KEY_PATH` | Public key used to verify firmware manifests |
| `DEVICE_ID` | Default device identifier reserved for configuration |

## Firmware signing and registration

Sign a firmware image with a private signing key:

```powershell
node scripts/sign_firmware.js --firmware .\firmware.bin --version 1.2.0 --device-type esp32 --key C:\Users\Dell\.iot-keys\signing-private.pem --out ..\release
```

The signer reads `FIRMWARE_BASE_URL` from `.env` for generated URLs. Optional `--base-url <https://host:port>` overrides it. Optional `--encrypt --encryption-key <path>` encrypts with AES-256-GCM. The key file must contain 32 raw bytes. The encrypted output is what gets hashed and signed. Devices need the matching key and must authenticate/decrypt the ciphertext before installation. Register the generated manifest and firmware path with `POST /api/firmwares`.

### Manifest signature contract

The signer and backend sign the UTF-8 bytes (without a trailing newline) of `IOTFW1|device_type|version|min_version|size|sha256_hex|encrypted`, where `encrypted` is `1` or `0`. Both version fields are strict semantic versions; `size` and lowercase `sha256_hex` describe the final firmware bytes (after encryption when enabled). The signature is ECDSA P-256 over SHA-256 of that message, encoded as a 64-byte IEEE P1363 `r||s` value and then base64 in `manifest.signature`. `signature_alg` is `ECDSA-P256-SHA256-P1363`. The device must construct this exact message and verify the signature before trusting manifest metadata.

Use `--base-url <https://host:port>` to override the signer’s default firmware URL base. To export the configured public PEM as an uncompressed P-256 C array, run `node scripts/export_pubkey_c.js --pub <public.pem> --out <signing_pubkey.h>`; the exporter reads only the specified public PEM.

The server verifies the manifest schema, ECDSA signature, file length, and SHA-256 digest before copying the firmware into managed storage. Firmware source files must resolve to regular files inside `FIRMWARE_SOURCE_DIR`; same type/version registrations are idempotent only when size and SHA-256 match. Firmware URLs do not expose directory listings and are constrained to valid device/version paths. Byte `Range` requests apply to `firmware.bin`; `manifest.json` is served without range support.

## Publier et déployer une version en 3 commandes

La signature est créée **localement sur le PC développeur** avec la clé privée `%USERPROFILE%\.iot-keys\signing-private.pem` (ou `--key`). La clé ne quitte jamais le PC et n’est jamais lue par le backend ou le tableau de bord. Le CLI lit `ADMIN_API_TOKEN` dans `.env` sans l’afficher. TLS reste vérifié avec la CA privée (`CA_CERT` dans `.env`, ou `..\mosq\ca.crt` par défaut).

1. Définir `PROJECT_VER` sur la version cible dans `wifi_base/CMakeLists.txt`, puis compiler depuis ESP-IDF :

   ```powershell
   cd ..\wifi_base
   idf.py build
   cd ..\backend
   ```

2. Pré-vérifier, signer et enregistrer le binaire correspondant. Le CLI vérifie l’image ESP, son descripteur/version intégrée, le slot, l’état HTTPS et l’absence d’une version déjà enregistrée :

   ```powershell
   npm run release -- --version 1.8.7 --min-version 1.8.6
   ```

   Ajouter `--deploy` pour demander confirmation puis lancer l’OTA et suivre ses transitions. Ajouter `--yes` seulement dans un environnement maîtrisé pour éviter l’invite interactive. Le chemin du binaire est optionnel; par défaut c’est `..\wifi_base\build\wifi_base.bin`.

3. Vérifier le statut à tout moment :

   ```powershell
   npm run status
   ```

Depuis le tableau de bord : ouvrir **Firmwares**, cliquer **Rechercher de nouvelles versions**, puis **Déployer** sur une version disponible. La boîte de dialogue montre l’appareil, les versions, la taille, l’algorithme de signature et l’avertissement de redémarrage. Le suivi affiche l’état et l’erreur éventuelle.

| Erreur | Signification et action |
|---|---|
| `FIRMWARE_VERSION_EXISTS` | Version déjà publiée avec des octets différents; choisir une nouvelle version. |
| `INVALID_MANIFEST` | Vérifier `version`, `min_version` et la signature générée localement. |
| `version_not_newer` | La cible doit dépasser la version/high-water mark; construire une version supérieure. |
| `untrusted_url` | Vérifier que l’URL HTTPS et l’adresse backend configurée correspondent aux SAN et à la base approuvée du firmware. |
| `signature_invalid` | Re-signer le binaire correspondant avec la clé privée de développement correcte; ne jamais transférer la clé. |
| `hash_mismatch` | Le binaire ou le manifeste a changé après signature; refaire une release avec un nouveau numéro. |
| `new_app_not_confirmed` | Le contrôle de santé a échoué; garder le rollback et examiner le moniteur série. |
| `command_expired` | Relancer une nouvelle demande après vérification que l’ancienne est terminale. |

`ota.ps1` reste disponible pour compatibilité, mais est considéré comme legacy; préférer `npm run release`.

## API

All routes except `GET /api/health` require `Authorization: Bearer <ADMIN_API_TOKEN>`. Responses use JSON. Example PowerShell-compatible curl:

```powershell
$token = "<ADMIN_API_TOKEN>"
$headers = @{ Authorization = "Bearer $token" }
curl.exe --ssl-no-revoke --cacert C:\path\to\ca.crt https://10.210.189.35:8443/api/health
curl.exe --ssl-no-revoke --cacert C:\path\to\ca.crt -H "Authorization: Bearer $token" https://10.210.189.35:8443/api/devices
curl.exe --ssl-no-revoke --cacert C:\path\to\ca.crt -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d '{"manifest":{...},"firmware_path":"..\\release\\firmware.bin"}' https://10.210.189.35:8443/api/firmwares
curl.exe --ssl-no-revoke --cacert C:\path\to\ca.crt -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d '{"device_id":"esp32-001","version":"1.2.0"}' https://10.210.189.35:8443/api/updates
curl.exe --ssl-no-revoke --cacert C:\path\to\ca.crt -H "Authorization: Bearer $token" https://10.210.189.35:8443/api/updates/<request-id>
curl.exe --ssl-no-revoke --cacert C:\path\to\ca.crt -H "Authorization: Bearer $token" "https://10.210.189.35:8443/api/security-events?severity=warning"
```

Routes: `GET /api/health`, `GET /api/devices`, `GET /api/devices/:id`, `GET/POST /api/firmwares`, `POST /api/updates`, `GET /api/updates/:id`, and `GET /api/security-events`. One active update is allowed per device. Failed updates are never resent automatically. A retry requires a new admin request. Requested firmware must be newer than the device's reported version and at or above its `min_allowed_version`.

### Update lifecycle and device status

Update requests move through `created` → `sent` → `received` → `downloading` → `verifying` → `installing` → `rebooting` → `success`. Device failures, rejections, rollbacks, and expiry are terminal states. A request expires after its command expiry when no device response arrives for two minutes; `installing` and `rebooting` receive five minutes after the last status to allow reboot and reconnect. Expiry is checked when a request is read, before creating another request for its device, and periodically.

On `iot/stm32/update/status`, the device sends a JSON object with required `request_id` (UUID), `device_id`, `state`, and integer `progress` (0–100). Allowed states are `received`, `downloading`, `verifying`, `installing`, `rebooting`, `success`, `failed`, `rolled_back`, and `rejected`. `error_code`, `version`, and numeric `ts` are optional. Unknown requests and device ID mismatches are ignored. Gateway presence and version reports on `iot/esp32/status` accept `device_id`, `target`, `version`, `state`, and `uptime_s`; a reported firmware version updates the device registry, while `min_allowed_version` cannot be lowered by a status report.

## MQTT contract

Topics are defined only in `src/config/topics.js`. Commands publish at QoS 1 without retain and include `request_id`, `device_id`, `target`, `version`, `manifest_url`, `issued_at`, and `expires_at`. Incoming payloads are size-bounded and validated; malformed and unknown update status messages are dropped and logged. The configured broker ACL must allow the backend to publish commands and read the device status/security topics. This implementation retains the supplied ACL and does not broaden it.

## Tests

```powershell
npm test
npm audit
```

Tests cover command publishing/idempotency, signature and hash rejection, anti-rollback, expiry/unknown statuses, illegal transitions, and malformed status payloads. They use a temporary JSON store and a mocked MQTT publisher; they do not require live Mosquitto credentials or certificates.

## Tableau de bord OTA et rapports

Après le démarrage du backend, ouvrez `https://<adresse-configurée>:8443/dashboard/` et saisissez le jeton `ADMIN_API_TOKEN` dans le formulaire. Le jeton reste uniquement en mémoire dans la page et est effacé au rechargement ou à la déconnexion. Le tableau de bord présente l’aperçu, les mises à jour, les firmwares, les événements de sécurité, T01–T14 et le rapport imprimable.

Les résultats résident dans `reports/results/`; les preuves texte filtrées sont dans `reports/evidence/`. Enregistrer un résultat sans afficher de secrets :

```powershell
node scripts/add_test_result.js --id=T02 --status=NOT_RUN --fw-from=1.2.0 --fw-to=1.3.0 --summary="Procédure en attente d’un essai sur carte" --notes="Ne pas inclure de jeton ou de donnée de clé."
```

Joindre un ou plusieurs fichiers texte avec des options répétées `--evidence=<chemin>`. Le script refuse les binaires, les chemins `.env`/données/clés, les fichiers de plus de 200 KB, et masque les lignes/valeurs sensibles avant copie. Après mise à jour des résultats, régénérer les rapports avec `node scripts/build_report.js`. Les sorties sont `reports/OTA_TEST_REPORT.md`, `reports/OTA_TEST_REPORT.html` et `reports/tests/T01.md` à `T14.md`. La checklist manuelle est `reports/DASHBOARD_CHECKLIST.md`.

## Storage and security notes

The JSON store writes through a temporary file followed by atomic rename. It is appropriate for this small project, not concurrent multi-process workloads. Admin bearer tokens are compared in constant time for equal-length values, invalid authentication is recorded without recording token values, and logs do not include MQTT payloads. TLS verification is enabled and never disabled. Firmware signatures are mandatory; a command received over MQTT is only a request to check for an update, not proof that firmware is trustworthy.

The device must enforce the security boundary: authenticate the manifest signature with a trusted public key, hash the downloaded bytes, enforce hardware target and anti-rollback version, validate issued/expiry times, authenticate/decrypt AES-GCM data if encrypted, and only then hand the image to its secure boot/update flow. Secure Boot key provisioning, protected key storage, and rollback enforcement remain device responsibilities.

## Validation firmware et procédure matérielle

Le client ESP32 vérifie maintenant la signature de manifeste ECDSA/P-256, le SHA-256 et la taille du fichier téléchargé avant de sélectionner le slot OTA. Il applique une fenêtre anti-rejeu NVS de huit identifiants et une version haute persistante; NVS n’est jamais effacé automatiquement. Le rollback reste indisponible tant que `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` n’est pas activé et flashé via USB.

Le traitement AES-256-GCM est conditionné à un header local ignoré par Git (`wifi_base/main/fw_key.h`). `node scripts/export_fw_key_c.js` sait générer ce header à partir de `.iot-keys/fw-aes.key`, mais ce script n’a pas été exécuté dans cette revue: la clé AES n’a pas été lue. Sans header, le firmware rejette l’encryption avec `encrypted_not_supported_yet`. Même avec le header, cette clé embarquée est réservée au développement et ne constitue pas un stockage de production.

Les scénarios matériels T02–T09 sont documentés dans [`reports/BOARD_TEST_PROCEDURES.md`](reports/BOARD_TEST_PROCEDURES.md); ils sont des procédures futures et n’ont pas été lancés. La perspective T14 est dans [`reports/SECURE_BOOT_FLASH_ENCRYPTION_PLAN.md`](reports/SECURE_BOOT_FLASH_ENCRYPTION_PLAN.md). Aucun test n’a contacté l’ESP32.

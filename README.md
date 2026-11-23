# Secure IoT OTA Demonstration

This project demonstrates secure over-the-air (OTA) firmware updates for an ESP32. The ESP32 connects to Wi-Fi and a TLS-protected Mosquitto broker, receives an authenticated update command from the Node.js backend, downloads a signed firmware release over HTTPS, verifies it, installs it, and reports its status.

## Project folders

| Folder | Contents |
|---|---|
| `backend/` | HTTPS API, OTA dashboard, firmware signing and release scripts, tests, and detailed backend documentation. |
| `wifi_base/` | ESP-IDF project for the ESP32 firmware. |
| `mosq/` | Mosquitto configuration and local TLS certificates. Keep private keys protected. |
| `release/` | Signed firmware release folders. Do not change a release after signing or registration. |

For backend routes, environment variables, manifest verification, MQTT topics, and test details, see [`backend/README.md`](backend/README.md).

## Prerequisites

- Windows, Node.js 18 or later, and npm.
- ESP-IDF 6.1 configured in an ESP-IDF PowerShell terminal.
- An ESP32 connected over USB. This setup has used COM9; check Device Manager if the port changes.
- Mosquitto configured with the project certificates and ACL.
- A private firmware-signing key at `%USERPROFILE%\.iot-keys\signing-private.pem` and a corresponding public key configured in the backend/device.

Keep `.env`, API tokens, broker passwords, signing keys, and other private keys out of screenshots, chats, and source control. Do not disable TLS certificate checks.

## Start the system

Use separate PowerShell terminals for the broker and backend. Leave both running while the ESP32 and dashboard are in use. Start only one Mosquitto instance and one backend instance.

### 1. Start Mosquitto

If Mosquitto is not already running as a service, open a terminal and run:

```powershell
cd C:\Users\Dell\Documents\iot
& 'C:\Program Files\mosquitto\mosquitto.exe' -c 'C:\Users\Dell\Documents\iot\mosq\mosquitto.conf'
```

Leave this terminal open. If the broker port is already in use, check whether Mosquitto is already running instead of starting a second instance.

### 2. Start the backend

In another terminal:

```powershell
cd C:\Users\Dell\Documents\iot\backend
npm start
```

Leave it open. If Node reports `EADDRINUSE` on port 8443, stop the older backend process before starting another; do not stop Mosquitto to fix a backend port conflict.

Check the HTTPS health endpoint using the project CA certificate:

```powershell
curl.exe --ssl-no-revoke --cacert C:\Users\Dell\Documents\iot\mosq\ca.crt https://10.210.189.35:8443/api/health
```

Expected response includes `"status":"ok"` and `"mqtt_connected":true`. The example IP is the LAN address used when this README was written; if the PC receives a different IP, use that address only after updating the backend URL, certificate SANs, and device trust configuration consistently. Never use `curl -k` or disable TLS verification.

### 3. Open the dashboard

Open `https://10.210.189.35:8443/dashboard/` in a browser and sign in with the administrator API token from the local backend configuration. Do not paste the token into a chat or screenshot. Confirm the device `esp32-001` is online before deploying.

## Build and flash over USB

Use USB flashing to set up a baseline or recover a device. For the live OTA demonstration, do not USB-flash between the color stages.

In the ESP-IDF PowerShell terminal:

```powershell
cd C:\Users\Dell\Documents\iot\wifi_base
idf.py -p COM9 build flash monitor
```

The serial monitor uses 115200 baud by default. On boot, check `App version`, `Application wifi_base version`, and `Demo RGB LED`. A successful flash should show the version compiled into the project. Do not run `idf.py erase-flash` for this demonstration; the device stores anti-rollback state in NVS.

## Prepare a signed OTA release

The version in `wifi_base/CMakeLists.txt` (`PROJECT_VER`) is compiled into the firmware. LED colors are selected by the thresholds in `wifi_base/main/wifi_base.c`; changing `PROJECT_VER` alone does not select a color.

The current source is configured for this demo sequence:

| Firmware version | Expected LED |
|---|---|
| 1.8.27 | Red |
| 1.8.28 | Green |
| 1.8.29 | Blue |

Check the color thresholds in `wifi_base/main/wifi_base.c` before relying on this mapping. For each release, use a new, unused version and follow these steps:

1. Set `PROJECT_VER` in `wifi_base/CMakeLists.txt` to the version being prepared.
2. Build from ESP-IDF PowerShell:

   ```powershell
   cd C:\Users\Dell\Documents\iot\wifi_base
   idf.py build
   ```

   Confirm the build output says `App "wifi_base" version: <the version you set>`.

3. Sign and register from the backend folder:

   ```powershell
   cd C:\Users\Dell\Documents\iot\backend
   npm run release -- --version 1.8.28 --min-version 1.7.0 --device-type esp32 --key "$env:USERPROFILE\.iot-keys\signing-private.pem"
   ```

   Replace `1.8.28` with the version just built. This command signs the build and registers it with the backend; it does not send an OTA command unless `--deploy` is added. For a presentation, prepare and register all releases beforehand. Do not reuse an already registered version with different bytes.

## Run the red → green → blue OTA demo

The demo must always move to strictly newer versions. The device checks both its running version and its persistent anti-rollback high-water mark; an older or equal OTA target is rejected as `version_not_newer`.

1. Confirm the device is online on the red baseline. For the current source mapping, that is 1.8.27. If the device is on a newer version or has a higher anti-rollback floor, choose three newer, unused versions and adjust the color thresholds before building.
2. In the dashboard, open **Firmwares**, choose the green release (currently 1.8.28), click **Déployer**, and confirm once.
3. Keep the COM9 serial monitor open. Wait for the device to reboot/reconnect and report the green version and `Demo RGB LED: green` before proceeding.
4. Deploy the blue release (currently 1.8.29) in the same way. Wait for `Demo RGB LED: blue`.

Only one update can be active for a device. If **Déployer** is disabled or the backend returns `UPDATE_ACTIVE`, wait until the current update reaches a terminal state (`success`, `failed`, `rejected`, `rolled_back`, or `expired`). Do not repeatedly click or create duplicate requests. A dashboard state of `sent` means the command was sent; verify the actual app version and color in the serial monitor as well.

## Optional shorter command lifetime

New update commands use `COMMAND_TTL_SECONDS` (default 600 seconds; allowed range 30–3600). To run the backend temporarily with a 60-second command lifetime without editing `.env`, stop the backend and start it in the same PowerShell window with:

```powershell
cd C:\Users\Dell\Documents\iot\backend
$env:COMMAND_TTL_SECONDS = '60'
npm start
```

This only affects new commands after the backend restarts. The backend also has a response grace period, so the device may remain blocked longer than one minute if it does not report an update state. Avoid setting a very short lifetime for a real device on an unreliable network.

## Useful checks and troubleshooting

- **`version_not_newer` on the ESP32:** the OTA version is not above the running version or saved anti-rollback floor. Choose a higher unused version; do not erase NVS to bypass the check.
- **`UPDATE_ACTIVE` / disabled Deploy button:** wait for the existing update to become terminal. The release may already be installed even if its dashboard history is stale; check the device's reported version and serial output.
- **`INVALID_INPUT` from `/api/updates`:** inspect the request body and backend version. The dashboard request should contain `device_id`, `version`, and optional `source: "dashboard"`.
- **`EADDRINUSE` on 8443:** a backend process already owns the port. Stop the older Node backend instance, then start one backend.
- **429 Too Many Requests:** stop repeated clicking and allow the rate-limit window to pass. The CLI deployment script polls with backoff; do not launch multiple deployment scripts for the same device.
- **ESP32 Wi-Fi or MQTT connection failure:** confirm the PC and ESP32 are on the same reachable LAN, the broker is running, the device is online in the dashboard, and the certificate SANs match the current IP.
- **Wrong LED color:** check both the boot `App version` and `Demo RGB LED` lines. If the log reports the expected color but the physical LED differs, verify common-cathode wiring: red GPIO23, green GPIO22, blue GPIO21, common cathode to GND, with a resistor on each channel.

## Backend checks

From `backend/`, run:

```powershell
npm test
npm audit
```

The backend README describes the API and tests in more detail. Do not use production credentials in tests, and do not send real update commands while running isolated QA scripts.
"# secure-ota" 

# Backend and MQTT QA report

**Run date:** 2026-11-07  
**Scope:** Read-only review plus isolated QA server/services using temporary JSON state, temporary firmware files, a generated test-only ECDSA key, and a no-op MQTT publisher. No production files were changed; no update was posted and the ESP32 was not contacted. Broker tests were not run because only the backend's configured credentials are present and the prompt requires test credentials.

Evidence scripts:

- `qa/isolated_qa.mjs` — isolated HTTP, firmware registration/serving, and update lifecycle checks; reproduces findings E1, C6, C7, and D1.
- `qa/live_readonly.ps1` — CA-verified live GETs and TLS refusal probes; reads the admin token from `.env` internally and never prints it.
- `qa/check_cert_san.mjs` — checks the configured public certificate SAN without printing certificate contents.

## Summary table

| ID | Test | Result | Evidence |
|---|---|---|---|
| A1 | Missing, wrong, malformed, empty, and query-string auth; generic response and auth event | PASS | isolated script: five 401s; events omit token; source logs event type/device only |
| A2 | Unauthenticated health response | PASS | live probe: HTTP 200, `{status:ok,mqtt_connected:true}`; no secrets/library versions |
| A3 | HTTP refused; TLS 1.0/1.1, wrong hostname, untrusted CA; SAN | PASS | live probe: HTTP empty reply; TLS 1.0/1.1 curl exit 35; hostname/untrusted curl exit 60; certificate SAN check true |
| A4 | Helmet headers, X-Powered-By, wildcard CORS | PASS | isolated HTTP server; authenticated and unauthenticated responses checked |
| A5 | Rate limit and recovery | NOT RUN | limit is 120 requests/minute; attached prompt caps burst at 50, below configured threshold |
| B1 | Broad Zod validation matrix | NOT RUN | only strict extra-field rejection exercised; remaining matrix needs more isolated cases |
| B2 | Oversized body, malformed JSON, standard error shape/no stack | PASS | isolated script: 413; malformed JSON 400 structured error without stack |
| B3 | Malformed/path-like/injection-shaped API IDs | PASS | isolated script: malformed and injection-shaped update IDs returned 404, not 500 |
| C1 | Valid signed manifest and stored file hash | PASS | isolated generated-key test: accepted, stored SHA-256 matches |
| C2 | Tampering signed manifest fields | PASS | existing `npm test` covers version, target, min version, size, hash, and encryption mutations; each is rejected |
| C3 | Signature encoding/format variants | NOT RUN | existing suite covers DER and legacy algorithm label; raw lengths, wrong key, old file-only signature not exercised in this QA run |
| C4 | Truncated, extended, flipped, empty, and same-size wrong files | NOT RUN | existing tests cover altered content and hash/size mismatch; full requested file matrix not run |
| C5 | Firmware source path abuse | NOT RUN | no configured “release folder” boundary exists; registration accepts a caller-supplied local path. No path traversal or external file disclosure test was attempted |
| C6 | Duplicate type+version registration | FAIL | isolated script registers a second validly signed, different binary at the same version; it silently replaces the stored image |
| C7 | Downgrade and `min_version > version` registration | FAIL | isolated script confirms `version:1.0.0,min_version:1.1.0` is accepted |
| C8 | Stored and served `url` vs `firmware_url` | PASS | source and isolated registration show `url` ends in `manifest.json`; `firmware_url` ends in `firmware.bin`; both paths are served |
| D1 | Binary bytes, single ranges, suffix/open ranges, invalid/out-of-range/multi-range, manifest range | FAIL | isolated check confirms binary hash and basic `206`; multi-range returns `416`; manifest ignores Range and advertises `Accept-Ranges:none`. Other range forms not run |
| D2 | Directory listing and traversal | PASS | isolated `/firmware/` gives 404; normalized traversal gives 404. Encoded/double-encoded/backslash/null variants not run |
| D3 | Unknown type/version and Windows path edge cases | NOT RUN | not exercised |
| D4 | Firmware authentication/public availability and content secrecy | INFO | isolated binary GET succeeds without a token; this is compatible with device downloads. No production firmware was scanned for secrets |
| E1 | Unknown device/version, target, reported-version downgrade, min version | FAIL | isolated same-version request for device at `1.0.0` was accepted as `sent`; unknown device/version and wrong-target cases not all exercised. Existing anti-rollback test covers below-minimum rejection |
| E2 | One active request and retry after expiry | PASS | ten simultaneous same-device requests yielded exactly one acceptance; a new request was accepted after simulated expiry |
| E3 | Stale sent expiry and installing grace | PASS | fake-clock tests verify sent expiry after TTL plus 2-minute grace, warning event, and installing grace until 5 minutes after last status |
| E4 | Command fields, QoS, retain, TTL, URL, uniqueness on actual wire | NOT RUN | isolated mock verifies command fields; source sets QoS 1/retain false and config caps TTL at 3600. No broker wire capture |
| E5 | Failed updates are not automatically resent | NOT RUN | no broker/restart scenario run |
| F1 | MQTT payload schema and all allowed status names | PASS | isolated schema accepts all nine documented states and rejects bad state/fractional progress; full MQTT delivery/state progression not run |
| F2 | Unknown/mismatched request, ordering, terminal handling | NOT RUN | some status cases exist in the regular unit suite; full matrix not run against MQTT |
| F3 | Version tracking and minimum-version protection | PASS | existing `npm test` verifies success/gateway version update and minimum cannot be lowered |
| F4 | Failure security events and rollback severity | PASS | existing `npm test` verifies rejected/rolled-back events, error codes, and high rollback severity |
| F5 | Device-ID spoofing | NOT RUN | no broker test credentials; no MQTT injection attempted |
| F6 | ACL isolation, anonymous, non-TLS, TLS 1.1 | NOT RUN | ACL/config were not changed; broker protocol/auth tests require a test user, which was unavailable |
| F7 | Broker restart/reconnect/subscription restore | NOT RUN | no broker restart performed |
| G1 | Concurrent same-device updates | PASS | isolated script: exactly one of 10 concurrent calls accepted |
| G2 | Restart persistence/resume/no duplicate publish | NOT RUN | isolated JSON persistence was not subjected to process restart testing |
| G3 | Logs contain no secrets and event fields are complete | NOT RUN | no production logs were collected; source avoids logging credentials/payloads |
| G4 | `npm test`, `npm audit`, skipped/trivial coverage | PASS | `npm test`: 16 passed, 0 failed; `npm audit`: 0 vulnerabilities. See coverage notes below |

## Findings (severity order)

### Medium — same-version firmware can be registered over an existing release (C6)

- **What I did:** In an isolated temp store, registered a validly signed `esp32:1.2.0` image, then registered a different validly signed binary under the same type/version.
- **What happened:** Registration succeeded and replaced the stored binary and manifest at that release path. The behavior is not idempotent and is not rejected.
- **Expected:** Duplicate registration should reject a different digest, or explicitly accept only an identical digest as idempotent.
- **Impact:** Re-registering a release can change bytes delivered from a URL already associated with that version, undermining release immutability and auditability.
- **Suggested fix:** Compare existing type/version digest before writing; reject a different digest and make same-digest retries explicitly idempotent.
- **Reproduce:** `node qa/isolated_qa.mjs` (look for `C6 FAIL`). No credentials required.

### Medium — registration accepts `min_version` newer than the image version (C7)

- **What I did:** Registered a validly signed manifest for version `1.0.0` with `min_version` `1.1.0`.
- **What happened:** Registration accepted it.
- **Expected:** Reject an internally inconsistent anti-rollback floor that exceeds the firmware version.
- **Impact:** Devices may reject the image or persist a minimum version that prevents booting/updating to the registered version, depending on firmware policy.
- **Suggested fix:** Validate `min_version <= version` with the existing SemVer comparator before storing.
- **Reproduce:** `node qa/isolated_qa.mjs` (look for `C7-min-greater FAIL`).

### Medium — update request permits a version equal to the reported device version (E1)

- **What I did:** Seeded an isolated device at version `1.0.0`, registered firmware `1.0.0`, and requested that version.
- **What happened:** The request was accepted and reached `sent`.
- **Expected:** The matrix requires rejecting a version that is not newer than the reported version.
- **Impact:** Same-version reinstalls or unintended downgrade-like operations can be issued; the service currently enforces only `min_allowed_version`.
- **Suggested fix:** Compare the requested firmware version with the device's reported version and reject non-newer requests, with an explicit policy for repairs/reinstalls if those are required.
- **Reproduce:** `node qa/isolated_qa.mjs` (look for `E1-same-version FAIL`).

### Low — manifest endpoint does not support byte ranges (D1)

- **What I did:** Requested `Range: bytes=0-2` from the manifest URL on an isolated server.
- **What happened:** It returned the full manifest with HTTP 200 and `Accept-Ranges: none`.
- **Expected:** The test prompt says both firmware paths support Range. The binary path does support ranges; the manifest does not.
- **Impact:** The device flow described in the prompt fetches a small manifest and ranges the binary, so no break was observed for that flow. Clients requiring partial manifest reads will not work.
- **Suggested fix:** Either implement byte ranges for manifests or document that range support applies to firmware binaries only and update the test requirement accordingly.
- **Reproduce:** `node qa/isolated_qa.mjs` (look for `D1-manifest-range FAIL`).

### Info — firmware binaries are publicly downloadable (D4)

- **What I did:** Fetched the isolated firmware binary without an admin bearer token.
- **What happened:** The file was returned. The device is expected to download firmware without an API token.
- **Expected/impact:** Public read access is consistent with this device flow if the firmware image contains no secrets. Production firmware contents were not scanned, so secrecy cannot be confirmed here.
- **Suggested fix:** Keep credentials/private material out of firmware images; use signed metadata and hashes for authenticity/integrity. Consider authenticated downloads only if the device can securely obtain download credentials.
- **Reproduce:** `node qa/isolated_qa.mjs` (look for `D4 INFO`).

## Other checks and coverage notes

- The live backend returned health HTTP 200 with `mqtt_connected:true`. A verified GET of request `4fdf59c2-2a19-46fd-a5fa-bccb9921a14f` returned `expired`; a verified GET showed `esp32-001` at version `1.0.0`. No live POST or publish was performed.
- Process note: one initial read-only probe accidentally used PowerShell's certificate-skip option. It only fetched the stale update and did not change state; that result was discarded and the same GET was repeated successfully with `curl.exe --ssl-no-revoke --cacert <configured CA>`. No certificate-bypass result is counted as test evidence.
- TLS checks used `curl.exe --ssl-no-revoke --cacert <configured CA>`: TLS 1.0/1.1 attempts, wrong hostname, and using the backend leaf certificate as the trust CA all failed; plain HTTP received an empty reply. The configured certificate SAN includes `192.168.0.217`.
- Rate limiting was not forced: configured threshold is 120/minute, while the allowed bounded burst is at most 50.
- MQTT broker tests (F1-F7) were not run. Configured credentials are production backend credentials, not test credentials; the real board and broker were not used for status injection or restart testing.
- The standard test suite has 16 tests and passed. Some tests combine several assertions; it is a service/API test suite, not a complete broker integration or hardware test suite. The isolated QA script adds targeted registration, expiry, API, and serving coverage.
- No test was skipped by `node --test`; several requested matrix cases are explicitly NOT RUN above.

## Manual ESP32 checklist (do not run from this QA job)

Use a test firmware release and admin token stored in your local shell, never pasted into logs. Observe backend status with the read-only API and device output locally. Commands below are templates; replace placeholders locally.

1. **H1 Boot:** Open the serial monitor at the firmware's configured baud rate; reboot the board. Confirm partition table shows OTA slots and reported version is `1.0.0`.
2. **H2 OTA success:** Subscribe locally to `iot/stm32/update/status` and `iot/esp32/status` with your device test account. Submit one authorized `POST /api/updates` for `1.1.0`. Expect `received → downloading → verifying → installing → rebooting → success`, reboot into `ota_1`, and backend/device version `1.1.0`.
3. **H3 Rollback:** Build `1.2.0` with `SIMULATE_BAD_FIRMWARE=1`, register it using a test signing key, and request it. Expect `rolled_back` with `new_app_not_confirmed`; board returns to bootable `1.1.0`.
4. **H4 Tampered binary:** In a disposable release only, flip one byte after registration and request the update. Stage 1 may download/install without hash enforcement; Stage 2 must reject before install due to hash/signature mismatch.
5. **H5 Manifest/signature mismatch:** In a disposable build, test wrong signature, `device_type`, and version. Expect rejection with the matching device `error_code` and no install.
6. **H6 Time/replay:** Send an expired command, future `issued_at`, and a repeated `request_id` in the device test harness. Expect `command_expired`, `issued_in_future`, and replay rejection; no second install.
7. **H7 Wi-Fi loss:** Drop Wi-Fi during download. Expect a failure status, old image retained, and successful reboot.
8. **H8 Power interruption:** On a spare board, interrupt during download and just after reboot. Expect bootloader to select a valid old or new image and remain recoverable.
9. **H9 URL policy:** In a test harness, send `http://`, an untrusted host, and a traversal URL. Expect rejection before download.
10. **H10 Stage 3:** Later verify Secure Boot signature enforcement and flash-encryption configuration on hardware; no command is provided because provisioning is board/vendor-specific.

## 10-line verdict

1. **Demonstration readiness for 17 November: conditional; do not demonstrate update registration as release-immutable yet.**
2. The isolated API/security checks passed for the exercised cases.
3. Live health, stale-update GET, and device GET succeeded over CA-verified HTTPS.
4. No production update was posted and the ESP32 was not contacted.
5. Medium: prevent different binaries from silently replacing a registered type/version.
6. Medium: reject manifests whose `min_version` exceeds `version`.
7. Medium: reject update requests at or below the device's reported version (unless explicitly authorized as repair).
8. Low: align manifest Range behavior with the documented test contract or narrow that contract to binaries.
9. Broker ACL/reconnect, full MQTT flow, hardware OTA/rollback, rate-limit behavior, and production firmware secret scanning remain unverified.
10. The configured live TLS endpoint rejected legacy TLS and hostname/CA mismatches; `npm test` passed 16/16 and `npm audit` found 0 vulnerabilities.

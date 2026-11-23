# OTA release and dashboard manual checklist

- [ ] Build with `PROJECT_VER` matching the intended semantic version.
- [ ] `npm run release -- --version X.Y.Z --min-version A.B.C` refuses a wrong or oversized binary before signing.
- [ ] The version table shows size, shortened SHA-256, signature algorithm, registration time, and deployed status.
- [ ] **Rechercher de nouvelles versions** registers valid direct release folders, ignores non-semver names, and reports rejections without filesystem paths.
- [ ] Repeating the scan reports `already_registered` for identical releases and does not duplicate records.
- [ ] **Déployer** is disabled for offline devices, active requests, and non-newer releases with a visible reason.
- [ ] Confirmation dialog names device/current/target, image size, signature algorithm, and reboot warning.
- [ ] Confirming logs an audit event without any token and shows live state/progress/error details.
- [ ] On the board, verify TLS connection, download, signature/hash verification, reboot, new version, and success status.
- [ ] Do not use real credentials or the production signing key for isolated tests; never bypass TLS verification.

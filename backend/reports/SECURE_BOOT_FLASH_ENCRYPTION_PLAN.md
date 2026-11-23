# Plan T14 — Secure Boot V2 et flash encryption (ESP32-D0WD-V3)

**Statut : perspective uniquement.** Aucun menuconfig, build sécurisé, accès aux eFuses, flash ou test matériel n’a été réalisé. Le plan nécessite une approbation explicite et un appareil de réserve.

## Compatibilité et options ESP-IDF 6.1

La documentation Espressif pour ESP32 indique Secure Boot V2 RSA sur les révisions v3.0 et ultérieures. La carte est rapportée comme ESP32-D0WD-V3 / révision 3.1, mais il faut la confirmer sur l’appareil avant toute modification. Le projet actuel n’a ni Secure Boot ni chiffrement flash activé; `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` est également absent/désactivé.

Dans `idf.py menuconfig`, prévoir une branche de configuration séparée, sauvegarder l’actuelle, puis examiner sans encore appliquer:

- `CONFIG_ESP32_REV_MIN=3.0` (minimum supporté v3.0, nécessaire pour exposer Secure Boot V2 RSA sur ESP32).
- `CONFIG_SECURE_BOOT=y` et `CONFIG_SECURE_BOOT_V2_ENABLED=y`.
- `CONFIG_SECURE_BOOT_BUILD_SIGNED_BINARIES=y` pour les builds signés localement. La clé PEM RSA-3072 doit être générée hors du dépôt et stockée dans un coffre hors ligne/contrôlé; ne jamais la placer dans `wifi_base/` ni l’inclure dans une preuve. Prévoir une revue de signature à distance/HSM avant production.
- `CONFIG_SECURE_FLASH_ENC_ENABLED=y` et `CONFIG_SECURE_FLASH_ENCRYPTION_MODE_DEVELOPMENT=y` uniquement pour l’essai de développement demandé. Ce mode est moins protecteur et n’est pas le choix de production.
- Garder le mode de téléchargement UART accessible pour le premier essai sur appareil de réserve; ne pas désactiver JTAG/UART ni passer au mode Release pendant cette campagne. Aucun verrouillage eFuse ne fait partie de ce plan.
- Vérifier séparément la taille du bootloader et les offsets de partition; Secure Boot/flash encryption peuvent augmenter les exigences de bootloader.

La documentation ESP-IDF donne pour une clé RSA-3072 une génération via `idf.py secure-generate-signing-key --version 2 --scheme rsa3072 <chemin-hors-projet>/secure-boot.pem`. Cette commande est documentée seulement et n’a pas été exécutée. Si le private signing key est externalisé, produire l’image padding/signature avec le workflow `idf.py secure-sign-data`/`espsecure` de la même version IDF, puis vérifier la signature avant tout transfert.

## Préconditions avant un essai futur

1. Utiliser un ESP32 de réserve v3.1, jamais la carte opérationnelle; garder câble USB/serial, alimentation stable et accès physique.
2. Sauvegarder tous les fichiers nécessaires et la configuration actuelle; identifier la méthode de récupération et le bon port COM avant la session.
3. Avec le port correctement identifié et sans écrire sur la carte, relever d’abord `python -m esptool --port COMx get-security-info`, puis l’identifiant/révision du chip. Sauvegarder le résultat sans données sensibles. Si la révision, l’état sécurité ou la disposition flash ne correspondent pas au plan, arrêter.
4. Vérifier sur un appareil vierge/consommable que l’image, le bootloader, le partition table et les artefacts sont cohérents, signés avec la bonne clé, et que les deux partitions OTA rentrent dans `0x1E0000`.
5. Obtenir une revue indépendante des options menuconfig et des procédures de récupération avant d’autoriser toute programmation. Conserver les clés Secure Boot chiffrées hors projet; aucune copie dans le dépôt, les rapports ou le firmware source.

## Effets sur OTA et signatures

Le firmware applicatif continuera à vérifier la signature de manifeste **ECDSA P-256/P1363** avec `SIGNING_PUBKEY` avant transfert, puis le digest SHA-256 et, si activé localement, l’authentification AES-GCM. Il s’agit d’une signature applicative de métadonnées et de provenance.

Secure Boot V2 ajoute une signature d’image **RSA-PSS 3072** vérifiée au démarrage par la chaîne ROM/bootloader (bloc de signature attaché à l’application et au bootloader). Elle ne remplace pas la signature ECDSA du manifeste: la première autorise le code exécutable au boot; la seconde lie version/cible/minimum/taille/hash au release demandé. Chaque nouvelle image OTA doit porter une signature Secure Boot acceptée par le digest public approuvé par l’appareil.

Avec flash encryption en mode développement, le bootloader chiffre les partitions flash applicables lors de l’initialisation; l’application s’exécute déchiffrée en mémoire. Les écritures OTA restent via les API OTA; les octets réseau ne doivent pas être chiffrés avec le chiffrement flash. Les blobs AES-256-GCM gérés par le niveau applicatif (T12) sont une couche différente.

## Résultats à vérifier au moniteur (pas exécutés)

Au premier démarrage, Espressif indique que le second-stage bootloader configure Secure Boot puis vérifie la signature de l’application. Relever les lignes réelles confirmant l’activation/validation et vérifier qu’aucune erreur de signature/configuration n’apparaît; ne pas accepter un simple démarrage réussi comme preuve suffisante. Pour flash encryption, attendre la fin du chiffrement initial et du redémarrage automatique, puis confirmer sur un redémarrage ultérieur qu’application et données chiffrées sont lues normalement. Les textes exacts dépendent du niveau de log et de la version; ne pas préremplir de lignes de log supposées dans les résultats.

## Récupération et risques

- Avant activation matérielle, un build ou une configuration incorrecte reste réversible en restaurant l’ancien `sdkconfig`/build et en reflashant une carte de réserve.
- Après Secure Boot V2 effectif, le bootloader et les applications doivent être signés par une clé correspondant au digest approuvé en eFuse. Un mauvais couple clé/digest ou une image incorrecte peut empêcher le démarrage; une mise à jour OTA correcte doit rester signée avec la clé autorisée.
- Le chiffrement flash est permanent après activation; les modes développement et production n’offrent pas le même niveau de récupération. Le mode développement garde des voies de téléchargement plus permissives, mais cela ne rend pas toute erreur de configuration réparable. Une UART désactivée, une clé perdue ou un bootloader incorrect peut supprimer les options de récupération.
- Ne pas brûler/écrire d’eFuse dans cette campagne. Toute activation irréversible nécessiterait un plan de provisioning distinct, une sauvegarde des clés et une validation de récupération signée.

T14 reste **NOT_RUN: plan documenté uniquement**.

## Références ESP-IDF officielles consultées

- [Secure Boot V2 — ESP-IDF Programming Guide v6.1](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/security/secure-boot-v2.html)
- [Flash Encryption — ESP-IDF Programming Guide](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/security/flash-encryption.html)
- [Security Features Enablement Workflows — ESP-IDF v6.1](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/security/security-features-enablement-workflows.html)
- [Configuration Options Reference — ESP32, ESP-IDF v6.1](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/kconfig-reference.html)

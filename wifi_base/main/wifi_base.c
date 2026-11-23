/*
 * wifi_base.c - Secure OTA client (ESP-IDF 6.x, ESP32)
 *
 * Wi-Fi + MQTT/TLS (private CA) + update command handling + HTTPS OTA + rollback.
 *
 * Manifest authenticity, firmware hash/size, target and version are checked before
 * selecting the new boot partition. OTA state and replay protection are persisted.
 *
 * error_code reference: wrong_device (command target mismatch); wrong_target (unsupported
 * target); bad_version (malformed version); untrusted_url (outside trusted HTTPS prefix);
 * time_not_synced (SNTP unavailable); bad_timestamps (invalid timestamps); command_expired
 * (expires_at elapsed); issued_in_future (issued_at too far ahead); ttl_too_long (command
 * lifetime exceeds limit); version_not_newer (version <= installed); replayed_request
 * (request_id already processed); replay_state_failed (could not persist request ID);
 * manifest_fetch_failed (manifest unavailable after retries); manifest_invalid (malformed);
 * manifest_wrong_target (manifest is not for esp32); manifest_version_mismatch (command and
 * manifest differ); bad_manifest_url (cannot derive firmware URL); bad_signature_alg
 * (unsupported signature label); signature_invalid (ECDSA verification failed); size_invalid
 * (signed size outside OTA slot); hash_mismatch (download size/digest differs); download_failed
 * (transfer failed); timeout (network timeout); encrypted_not_supported_yet (key unavailable);
 * decrypt_auth_failed (AES-GCM authentication failed); new_app_not_confirmed (health rollback);
 * bad_image_header (ESP image validation failed); wrong_application (project mismatch);
 * image_version_mismatch (image version differs); pending_state_failed (NVS update state failed);
 * install_failed (boot partition selection failed).
 *
 * Requires: espressif/mqtt, espressif/cjson (managed components), main/ca.crt,
 *           main/secrets.h (WIFI_SSID, WIFI_PASS, MQTT_USER, MQTT_PASS),
 *           PROJECT_VER set to a semantic version in the root CMakeLists.txt.
 */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <ctype.h>
#include <time.h>
#include <stdint.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "driver/gpio.h"
#include "esp_http_client.h"
#include "esp_ota_ops.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "mqtt_client.h"
#include "cJSON.h"
#include "mbedtls/base64.h"
#include "psa/crypto.h"
#include "signing_pubkey.h"
#if __has_include("fw_key.h")
#include "fw_key.h" /* generated locally; intentionally absent from source control */
#define OTA_HAS_DEV_AES_KEY 1
#else
#define OTA_HAS_DEV_AES_KEY 0
#endif
#include "secrets.h"

static const char *TAG = "iot";

static bool build_mqtt_uri(char *out, size_t out_len)
{
    static const char HTTPS_PREFIX[] = "https://";
    if (strncmp(BACKEND_BASE_URL, HTTPS_PREFIX, sizeof(HTTPS_PREFIX) - 1) != 0) return false;
    const char *authority = BACKEND_BASE_URL + sizeof(HTTPS_PREFIX) - 1;
    const char *end = strchr(authority, '/');
    if (end == NULL) end = authority + strlen(authority);
    const char *port = NULL;
    if (*authority == '[') {
        const char *close = memchr(authority, ']', (size_t)(end - authority));
        if (close == NULL || close + 1 >= end || close[1] != ':') return false;
        port = close + 1;
    } else {
        port = memchr(authority, ':', (size_t)(end - authority));
        if (port == NULL || memchr(port + 1, ':', (size_t)(end - port - 1)) != NULL) return false;
    }
    size_t host_len = (size_t)(port - authority);
    if (host_len == 0 || memchr(authority, '@', (size_t)(end - authority)) != NULL ||
        memchr(authority, '?', (size_t)(end - authority)) != NULL ||
        memchr(authority, '#', (size_t)(end - authority)) != NULL) return false;
    if (port + 1 >= end) return false;
    for (const char *p = port + 1; p < end; p++) if (!isdigit((unsigned char)*p)) return false;
    for (size_t i = 0; i < (size_t)(end - authority); i++) {
        unsigned char c = (unsigned char)authority[i];
        if (c <= 0x20 || c >= 0x7f || c == '\\') return false;
    }
    int n = snprintf(out, out_len, "mqtts://%.*s:8883", (int)host_len, authority);
    return n > 0 && (size_t)n < out_len;
}

/* ---- Identity, topics (must match the broker ACL) ---- */
#define DEVICE_ID            "esp32-001"
#define DEVICE_TARGET        "esp32"
#define TOPIC_STATUS         "iot/esp32/status"
#define TOPIC_UPDATE_CMD     "iot/stm32/update/command"
#define TOPIC_UPDATE_STATUS  "iot/stm32/update/status"

/* Only firmware/manifest URLs under this prefix are accepted (no arbitrary hosts). */
#define FW_BASE_URL          BACKEND_BASE_URL

#define STATUS_PERIOD_S      30
#define HEALTH_TIMEOUT_S     90     /* new app must reach the broker within this time */
#define CMD_MAX              1024
#define MANIFEST_MAX         2048
#define OTA_CHUNK_SIZE       4096
#define OTA_HTTP_TIMEOUT_MS  15000
#define OTA_RETRY_COUNT      3
#define OTA_REPLAY_SLOTS     8

#ifndef SIMULATE_BAD_FIRMWARE
#define SIMULATE_BAD_FIRMWARE 0     /* TEST ONLY: 1 prevents MQTT health confirmation to test rollback */
#endif
#ifndef OTA_DEBUG_METRICS
#define OTA_DEBUG_METRICS 0         /* TEST ONLY: compile with -DOTA_DEBUG_METRICS=1 */
#endif

extern const uint8_t ca_crt_start[] asm("_binary_ca_crt_start");
extern const uint8_t ca_crt_end[]   asm("_binary_ca_crt_end");

static EventGroupHandle_t wifi_events;
#define WIFI_CONNECTED_BIT BIT0

static QueueHandle_t update_queue;
static esp_mqtt_client_handle_t mqtt_client = NULL;
static volatile bool mqtt_connected = false;
static volatile bool app_confirmed = false;
static volatile bool boot_check_done = false;
static char last_req[64] = "";

static void log_update_metrics(const char *stage)
{
#if OTA_DEBUG_METRICS
    UBaseType_t words = uxTaskGetStackHighWaterMark(NULL);
    ESP_LOGI(TAG, "OTA metrics stage=%s free_heap=%u update_stack_free=%u",
             stage, (unsigned)esp_get_free_heap_size(), (unsigned)(words * sizeof(StackType_t)));
#else
    (void)stage;
#endif
}

typedef struct {
    size_t len;
    char data[CMD_MAX];
} cmd_msg_t;

/* ================================================================ helpers */
static bool time_ok(void)
{
    return time(NULL) > 1700000000;   /* SNTP has set the clock (after Nov 2023) */
}

static void iso_now(char *out, size_t len)
{
    time_t now = time_ok() ? time(NULL) : 0;
    struct tm t;
    gmtime_r(&now, &t);
    strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &t);
}

/* Accepts "2026-11-05T10:00:00Z" and "2026-11-05T10:00:00.000Z" (Node toISOString). */
static bool parse_iso(const char *s, time_t *out)
{
    int Y, M, D, h, m, sec, n = 0;
    if (sscanf(s, "%4d-%2d-%2dT%2d:%2d:%2d%n", &Y, &M, &D, &h, &m, &sec, &n) != 6) {
        return false;
    }
    const char *p = s + n;
    if (*p == '.') {
        p++;
        while (isdigit((unsigned char)*p)) p++;
    }
    if (*p != 'Z' || p[1] != '\0') return false;
    struct tm t = {0};
    t.tm_year = Y - 1900;
    t.tm_mon = M - 1;
    t.tm_mday = D;
    t.tm_hour = h;
    t.tm_min = m;
    t.tm_sec = sec;
    *out = mktime(&t);               /* TZ is set to UTC in app_main */
    return *out != (time_t)-1;
}

/* Only letters, digits and - _ . : are allowed: safe to place inside our JSON replies. */
static bool valid_token(const char *s, size_t max)
{
    size_t n = strlen(s);
    if (n == 0 || n >= max) return false;
    for (; *s; s++) {
        if (!(isalnum((unsigned char)*s) || *s == '-' || *s == '_' || *s == '.' || *s == ':')) {
            return false;
        }
    }
    return true;
}

static bool parse_semver(const char *s, unsigned v[3]);

static void log_untrusted_fw_url(const char *url)
{
    char safe_url[121]; size_t i = 0;
    for (; i < sizeof(safe_url) - 1 && url[i] != '\0'; i++) {
        unsigned char c = (unsigned char)url[i];
        safe_url[i] = (isalnum(c) || strchr("-._~:/", c) != NULL) ? (char)c : '?';
    }
    safe_url[i] = '\0';
    ESP_LOGW(TAG, "URL OTA refusee: recu='%s' attendu='%.*s/firmware/esp32/<semver>/manifest.json'",
             safe_url, 100, FW_BASE_URL);
}

static bool trusted_fw_url(const char *url, const char *expected_version)
{
    static const char PATH_PREFIX[] = "/firmware/esp32/";
    static const char MANIFEST_SUFFIX[] = "/manifest.json";
    static const char FIRMWARE_SUFFIX[] = "/firmware.bin";
    size_t base_len = strlen(FW_BASE_URL), n = strnlen(url, 200);
    if (base_len == 0 || n >= 200 || n <= base_len ||
        strncmp(url, FW_BASE_URL, base_len) != 0 || url[base_len] != '/') return false;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)url[i];
        if (c < 0x21 || c > 0x7e || c == '\\' || c == '%' || c == '?' || c == '#') return false;
    }
    if (strncmp(FW_BASE_URL, "https://", 8) != 0 ||
        strncmp(url + base_len, PATH_PREFIX, sizeof(PATH_PREFIX) - 1) != 0 || strstr(url + base_len, "//") != NULL ||
        strstr(url, "..") != NULL) return false;
    const char *version = url + base_len + sizeof(PATH_PREFIX) - 1;
    size_t remain = n - (size_t)(version - url);
    const char *suffix = NULL;
    if (remain > sizeof(MANIFEST_SUFFIX) - 1 &&
        strcmp(url + n - (sizeof(MANIFEST_SUFFIX) - 1), MANIFEST_SUFFIX) == 0) suffix = MANIFEST_SUFFIX;
    else if (remain > sizeof(FIRMWARE_SUFFIX) - 1 &&
             strcmp(url + n - (sizeof(FIRMWARE_SUFFIX) - 1), FIRMWARE_SUFFIX) == 0) suffix = FIRMWARE_SUFFIX;
    if (suffix == NULL) return false;
    size_t version_len = remain - strlen(suffix);
    if (version_len == 0 || version_len >= 32) return false;
    char version_buf[32]; memcpy(version_buf, version, version_len); version_buf[version_len] = '\0';
    unsigned parsed[3];
    if (!parse_semver(version_buf, parsed)) return false;
    for (size_t i = 0, part_start = 0; i <= version_len; i++) {
        if (i < version_len && !(isdigit((unsigned char)version_buf[i]) || version_buf[i] == '.')) return false;
        if (i == version_len || version_buf[i] == '.') {
            if (i == part_start || (i - part_start > 1 && version_buf[part_start] == '0')) return false;
            part_start = i + 1;
        }
    }
    if (expected_version != NULL && strcmp(version_buf, expected_version) != 0) return false;
    return true;
}

static bool parse_semver(const char *s, unsigned v[3])
{
    int n = 0;
    if (sscanf(s, "%u.%u.%u%n", &v[0], &v[1], &v[2], &n) != 3) return false;
    return s[n] == '\0';
}

static int cmp_semver(const unsigned a[3], const unsigned b[3])
{
    for (int i = 0; i < 3; i++) {
        if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

static bool json_str(cJSON *root, const char *key, char *out, size_t out_len)
{
    cJSON *it = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsString(it) || it->valuestring == NULL) return false;
    if (strlen(it->valuestring) >= out_len) return false;
    memcpy(out, it->valuestring, strlen(it->valuestring) + 1);
    return true;
}

static bool running_desc(esp_app_desc_t *d)
{
    const esp_partition_t *p = esp_ota_get_running_partition();
    return p != NULL && esp_ota_get_partition_description(p, d) == ESP_OK;
}

/* ============================================================ NVS (pending update) */
static bool nvs_set_pending(const char *req, const char *ver)
{
    nvs_handle_t h;
    if (nvs_open("ota", NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = nvs_set_str(h, "req", req);
    if (err == ESP_OK) err = nvs_set_str(h, "ver", ver);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err == ESP_OK;
}

static bool nvs_get_pending(char *req, size_t req_len, char *ver, size_t ver_len)
{
    nvs_handle_t h;
    if (nvs_open("ota", NVS_READONLY, &h) != ESP_OK) return false;
    bool ok = nvs_get_str(h, "req", req, &req_len) == ESP_OK &&
              nvs_get_str(h, "ver", ver, &ver_len) == ESP_OK;
    nvs_close(h);
    return ok;
}

static bool nvs_clear_pending(void)
{
    nvs_handle_t h;
    if (nvs_open("ota", NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t req_err = nvs_erase_key(h, "req");
    if (req_err == ESP_ERR_NVS_NOT_FOUND) req_err = ESP_OK;
    esp_err_t ver_err = nvs_erase_key(h, "ver");
    if (ver_err == ESP_ERR_NVS_NOT_FOUND) ver_err = ESP_OK;
    esp_err_t err = req_err == ESP_OK && ver_err == ESP_OK ? nvs_commit(h) : ESP_FAIL;
    nvs_close(h);
    return err == ESP_OK;
}

/* Persistent replay window and high-water version; these values share the OTA namespace. */
static bool nvs_request_seen(const char *req, bool *seen)
{
    nvs_handle_t h; *seen = false;
    if (nvs_open("ota", NVS_READONLY, &h) != ESP_OK) return false;
    for (unsigned i = 0; i < OTA_REPLAY_SLOTS; i++) {
        char key[8], value[64]; size_t n = sizeof value;
        snprintf(key, sizeof key, "rid%u", i);
        esp_err_t e = nvs_get_str(h, key, value, &n);
        if (e == ESP_OK && strcmp(value, req) == 0) *seen = true;
        else if (e != ESP_OK && e != ESP_ERR_NVS_NOT_FOUND) { nvs_close(h); return false; }
    }
    nvs_close(h); return true;
}
static bool nvs_record_request(const char *req)
{
    nvs_handle_t h; if (nvs_open("ota", NVS_READWRITE, &h) != ESP_OK) return false;
    uint8_t slot = 0; esp_err_t idx_err = nvs_get_u8(h, "rididx", &slot);
    if (idx_err != ESP_OK && idx_err != ESP_ERR_NVS_NOT_FOUND) { nvs_close(h); return false; }
    slot %= OTA_REPLAY_SLOTS;
    char key[8]; snprintf(key, sizeof key, "rid%u", slot);
    esp_err_t e = nvs_set_str(h, key, req);
    if (e == ESP_OK) e = nvs_set_u8(h, "rididx", (uint8_t)((slot + 1) % OTA_REPLAY_SLOTS));
    if (e == ESP_OK) e = nvs_commit(h);
    nvs_close(h);
    return e == ESP_OK;
}
static bool nvs_get_highwater(unsigned out[3], bool *present)
{
    nvs_handle_t h; *present = false;
    if (nvs_open("ota", NVS_READONLY, &h) != ESP_OK) return false;
    char v[32]; size_t n = sizeof v; esp_err_t e = nvs_get_str(h, "max_ver", v, &n); nvs_close(h);
    if (e == ESP_ERR_NVS_NOT_FOUND) return true;
    if (e != ESP_OK || !parse_semver(v, out)) return false;
    *present = true;
    return true;
}
static bool nvs_set_highwater(const char *version)
{
    nvs_handle_t h; if (nvs_open("ota", NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t e = nvs_set_str(h, "max_ver", version); if (e == ESP_OK) e = nvs_commit(h); nvs_close(h); return e == ESP_OK;
}

static bool json_int(cJSON *root, const char *key, uint32_t *out)
{
    cJSON *it = cJSON_GetObjectItemCaseSensitive(root, key);
    if (!cJSON_IsNumber(it) || it->valuedouble < 1 || it->valuedouble > UINT32_MAX || it->valuedouble != (double)(uint32_t)it->valuedouble) return false;
    *out = (uint32_t)it->valuedouble; return true;
}
static bool verify_manifest(cJSON *mf, const char *type, const char *version,
                            char *minv, size_t minv_len, uint32_t *size_out,
                            uint8_t digest_out[32], bool *encrypted,
                            uint8_t nonce[12], uint8_t tag[16])
{
    char sha[65], sigb64[128], alg[48]; unsigned mv[3], vv[3]; uint32_t size;
    if (!json_str(mf, "min_version", minv, minv_len) || !parse_semver(minv, mv) ||
        !parse_semver(version, vv) || cmp_semver(mv, vv) > 0 ||
        !json_int(mf, "size", &size) || !json_str(mf, "sha256", sha, sizeof sha) || strlen(sha) != 64 ||
        !json_str(mf, "signature", sigb64, sizeof sigb64) || !json_str(mf, "signature_alg", alg, sizeof alg) ||
        strcmp(alg, "ECDSA-P256-SHA256-P1363") != 0) return false;
    for (int i = 0; i < 64; i++) if (!isxdigit((unsigned char)sha[i])) return false;
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (part == NULL || size > part->size) return false;
    for (int i = 0; i < 32; i++) { unsigned x; if (sscanf(sha + 2*i, "%2x", &x) != 1) return false; digest_out[i] = (uint8_t)x; }
    uint8_t sig[64]; size_t siglen = 0; char canonical[96]; size_t canonical_len = 0;
    if (mbedtls_base64_decode(sig, sizeof sig, &siglen, (const unsigned char *)sigb64, strlen(sigb64)) != 0 || siglen != sizeof sig ||
        mbedtls_base64_encode((unsigned char *)canonical, sizeof canonical, &canonical_len, sig, sizeof sig) != 0 || canonical_len != strlen(sigb64) || strcmp(canonical, sigb64) != 0) return false;
    char msg[256]; int n = snprintf(msg, sizeof msg, "IOTFW1|%s|%s|%s|%u|%s|%u", type, version, minv, (unsigned)size, sha,
        cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(mf, "encrypted")) ? 1u : 0u);
    if (n <= 0 || n >= sizeof msg) return false;
    uint8_t hash[32]; size_t hashlen = 0;
    if (psa_hash_compute(PSA_ALG_SHA_256, (const uint8_t *)msg, (size_t)n, hash, sizeof hash, &hashlen) != PSA_SUCCESS || hashlen != sizeof hash) return false;
    psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT; mbedtls_svc_key_id_t key = 0;
    psa_set_key_type(&attr, PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_bits(&attr, 256); psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_VERIFY_HASH);
    psa_set_key_algorithm(&attr, PSA_ALG_ECDSA(PSA_ALG_SHA_256));
    psa_status_t ps = psa_import_key(&attr, SIGNING_PUBKEY, sizeof SIGNING_PUBKEY, &key);
    psa_reset_key_attributes(&attr);
    if (ps != PSA_SUCCESS) return false;
    ps = psa_verify_hash(key, PSA_ALG_ECDSA(PSA_ALG_SHA_256), hash, sizeof hash, sig, sizeof sig);
    (void)psa_destroy_key(key);
    if (ps != PSA_SUCCESS) return false;
    *size_out = size; *encrypted = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(mf, "encrypted"));
    if (*encrypted) {
        cJSON *enc = cJSON_GetObjectItemCaseSensitive(mf, "enc");
        char iv64[32], tag64[32], enc_alg[24], key_id[16]; size_t nout = 0;
        if (!cJSON_IsObject(enc) ||
            !json_str(enc, "alg", enc_alg, sizeof enc_alg) || strcmp(enc_alg, "AES-256-GCM") != 0 ||
            !json_str(enc, "key_id", key_id, sizeof key_id) || strcmp(key_id, "k1") != 0 ||
            !json_str(enc, "iv", iv64, sizeof iv64) || !json_str(enc, "tag", tag64, sizeof tag64) ||
            mbedtls_base64_decode(nonce, 12, &nout, (const unsigned char *)iv64, strlen(iv64)) != 0 || nout != 12 ||
            mbedtls_base64_decode(tag, 16, &nout, (const unsigned char *)tag64, strlen(tag64)) != 0 || nout != 16) return false;
    }
    return true;
}

/* ================================================================== status */
static bool pub_status(const char *req, const char *state, int progress,
                       const char *err, const char *ver)
{
    if (!mqtt_connected || mqtt_client == NULL) {
        ESP_LOGW(TAG, "Statut MQTT non publie: client deconnecte (state=%s)", state);
        return false;
    }
    char ts[24];
    char buf[400];
    iso_now(ts, sizeof ts);
    int n = snprintf(buf, sizeof buf,
                     "{\"request_id\":\"%s\",\"device_id\":\"%s\",\"state\":\"%s\",\"progress\":%d",
                     req, DEVICE_ID, state, progress);
    if (n < 0 || (size_t)n >= sizeof buf) return false;
    size_t used = (size_t)n;
    if (err) {
        n = snprintf(buf + used, sizeof buf - used, ",\"error_code\":\"%s\"", err);
        if (n < 0 || (size_t)n >= sizeof buf - used) return false;
        used += (size_t)n;
    }
    if (ver) {
        n = snprintf(buf + used, sizeof buf - used, ",\"version\":\"%s\"", ver);
        if (n < 0 || (size_t)n >= sizeof buf - used) return false;
        used += (size_t)n;
    }
    n = snprintf(buf + used, sizeof buf - used, ",\"ts\":\"%s\"}", ts);
    if (n < 0 || (size_t)n >= sizeof buf - used) return false;
    int msg_id = esp_mqtt_client_publish(mqtt_client, TOPIC_UPDATE_STATUS, buf, 0, 1, 0);
    if (msg_id < 0) {
        ESP_LOGW(TAG, "Publication status MQTT echouee: state=%s msg_id=%d", state, msg_id);
        return false;
    }
    ESP_LOGI(TAG, "Etat mise a jour: %s (%d%%)%s%s", state, progress,
             err ? " erreur=" : "", err ? err : "");
    return true;
}

static int build_status_json(char *buf, size_t len)
{
    esp_app_desc_t d;
    char v[32] = "unknown";
    if (running_desc(&d)) snprintf(v, sizeof v, "%s", d.version);
    return snprintf(buf, len,
        "{\"device_id\":\"%s\",\"target\":\"%s\",\"version\":\"%s\","
        "\"state\":\"online\",\"uptime_s\":%lld}",
        DEVICE_ID, DEVICE_TARGET, v, (long long)(esp_timer_get_time() / 1000000));
}

/* ============================================================== Wi-Fi */
static void wifi_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *d = (wifi_event_sta_disconnected_t *)data;
        xEventGroupClearBits(wifi_events, WIFI_CONNECTED_BIT);
        ESP_LOGW(TAG, "Wi-Fi perdu, raison=%d, nouvelle tentative", d->reason);
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Connecte, IP: " IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(wifi_events, WIFI_CONNECTED_BIT);
    }
}

static void network_task(void *arg)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_handler, NULL));

    wifi_config_t cfg = {0};
    strncpy((char *)cfg.sta.ssid, WIFI_SSID, sizeof(cfg.sta.ssid) - 1);
    strncpy((char *)cfg.sta.password, WIFI_PASS, sizeof(cfg.sta.password) - 1);
    cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    cfg.sta.pmf_cfg.capable = true;
    cfg.sta.pmf_cfg.required = false;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    vTaskDelete(NULL);
}

/* ====================================================== manifest + OTA */
static bool fetch_manifest(const char *url, char *buf, size_t buf_len)
{
    log_update_metrics("manifest_begin");
    esp_http_client_config_t cfg = {
        .url = url,
        .cert_pem = (const char *)ca_crt_start,   /* server identity checked against our CA */
        .timeout_ms = OTA_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (c == NULL) return false;
    bool ok = false;
    if (esp_http_client_open(c, 0) == ESP_OK) {
        int64_t clen = esp_http_client_fetch_headers(c);
        int status = esp_http_client_get_status_code(c);
        if (status == 200 && clen > 0 && clen < (int64_t)buf_len) {
            int total = 0;
            while (total < (int)clen) {
                int r = esp_http_client_read(c, buf + total, (int)clen - total);
                if (r <= 0) break;
                total += r;
            }
            if (total == (int)clen) {
                buf[total] = '\0';
                ok = true;
            }
        } else {
            ESP_LOGW(TAG, "Manifeste: statut HTTP %d, longueur %lld", status, (long long)clen);
        }
    }
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    log_update_metrics("manifest_end");
    return ok;
}

/* Stream one signed-size image, checking SHA-256 before app validation or boot-slot selection. */
static esp_err_t do_ota(const char *url, const char *req, const char *expect_ver,
                        uint32_t expected_size, const uint8_t expected_hash[32], bool encrypted,
                        const uint8_t nonce[12], const uint8_t tag[16],
                        const esp_partition_t **out_partition, const char **err_code)
{
    *out_partition = NULL;
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (part == NULL || expected_size == 0 || expected_size > part->size) { *err_code = "size_invalid"; return ESP_FAIL; }
    for (int attempt = 0; attempt < OTA_RETRY_COUNT; attempt++) {
        esp_http_client_config_t cfg = { .url=url, .cert_pem=(const char *)ca_crt_start, .timeout_ms=OTA_HTTP_TIMEOUT_MS };
        esp_http_client_handle_t c = esp_http_client_init(&cfg);
        if (c == NULL) { *err_code = "download_start_failed"; return ESP_FAIL; }
        esp_ota_handle_t ota = 0; bool ota_started = false; bool ok = false; uint32_t total = 0;
        psa_hash_operation_t hash_op = PSA_HASH_OPERATION_INIT;
        psa_aead_operation_t aead = PSA_AEAD_OPERATION_INIT;
        uint8_t buf[OTA_CHUNK_SIZE], plain[OTA_CHUNK_SIZE + 32], digest[32]; size_t digest_len = 0;
        mbedtls_svc_key_id_t aes_key = 0; bool aead_started = false;
        esp_err_t err = ESP_FAIL;
        if (esp_http_client_open(c, 0) == ESP_OK) {
            int64_t clen = esp_http_client_fetch_headers(c);
            if (esp_http_client_get_status_code(c) == 200 && clen == (int64_t)expected_size &&
                esp_ota_begin(part, expected_size, &ota) == ESP_OK &&
                psa_hash_setup(&hash_op, PSA_ALG_SHA_256) == PSA_SUCCESS) {
                ota_started = true; err = ESP_OK;
                if (encrypted) {
#if OTA_HAS_DEV_AES_KEY
                    psa_key_attributes_t ka = PSA_KEY_ATTRIBUTES_INIT;
                    psa_set_key_type(&ka, PSA_KEY_TYPE_AES); psa_set_key_bits(&ka, 256);
                    psa_set_key_usage_flags(&ka, PSA_KEY_USAGE_DECRYPT); psa_set_key_algorithm(&ka, PSA_ALG_GCM);
                    psa_status_t ks = psa_import_key(&ka, FW_AES_KEY, sizeof FW_AES_KEY, &aes_key); psa_reset_key_attributes(&ka);
                    if (ks == PSA_SUCCESS && psa_aead_decrypt_setup(&aead, aes_key, PSA_ALG_GCM) == PSA_SUCCESS &&
                        psa_aead_set_nonce(&aead, nonce, 12) == PSA_SUCCESS) aead_started = true;
                    else { *err_code = "decrypt_auth_failed"; err = ESP_FAIL; }
#else
                    *err_code = "encrypted_not_supported_yet"; err = ESP_FAIL;
#endif
                }
                while (err == ESP_OK && total < expected_size) {
                    int want = (int)((expected_size - total) > sizeof buf ? sizeof buf : expected_size - total);
                    int got = esp_http_client_read(c, (char *)buf, want);
                    if (got <= 0 || (uint32_t)got > expected_size-total) { err = ESP_FAIL; break; }
                    if (psa_hash_update(&hash_op, buf, (size_t)got) != PSA_SUCCESS) { err = ESP_FAIL; break; }
                    if (encrypted) {
                        size_t plain_len = 0;
                        if (!aead_started || psa_aead_update(&aead, buf, (size_t)got, plain, sizeof plain, &plain_len) != PSA_SUCCESS ||
                            (plain_len && esp_ota_write(ota, plain, plain_len) != ESP_OK)) { err = ESP_FAIL; break; }
                    } else if (esp_ota_write(ota, buf, (size_t)got) != ESP_OK) { err = ESP_FAIL; break; }
                    total += (uint32_t)got;
                    int pct = (int)(((uint64_t)total * 100) / expected_size);
                    pub_status(req, "downloading", pct, NULL, expect_ver);
                }
                bool hash_ok = err == ESP_OK && total == expected_size &&
                    psa_hash_finish(&hash_op, digest, sizeof digest, &digest_len) == PSA_SUCCESS && digest_len == sizeof digest &&
                    memcmp(digest, expected_hash, sizeof digest) == 0;
                bool decrypt_ok = !encrypted;
                if (hash_ok && encrypted) {
                    size_t tail_len = 0;
                    decrypt_ok = psa_aead_verify(&aead, plain, sizeof plain, &tail_len, tag, 16) == PSA_SUCCESS &&
                                 (tail_len == 0 || esp_ota_write(ota, plain, tail_len) == ESP_OK);
                }
                if (hash_ok && decrypt_ok) {
                    pub_status(req, "verifying", 100, NULL, expect_ver);
                    err = esp_ota_end(ota); ota_started = false;
                    if (err == ESP_OK) {
                        esp_app_desc_t nd, rd;
                        if (esp_ota_get_partition_description(part, &nd) != ESP_OK || !running_desc(&rd)) { err = ESP_FAIL; *err_code = "bad_image_header"; }
                        else if (strcmp(nd.project_name, rd.project_name) != 0) { err = ESP_FAIL; *err_code = "wrong_application"; }
                        else if (strcmp(nd.version, expect_ver) != 0) { err = ESP_FAIL; *err_code = "image_version_mismatch"; }
                        else { *out_partition = part; ok = true; }
                    }
                } else if (!hash_ok) {
                    if (*err_code == NULL) *err_code = total == expected_size ? "hash_mismatch" : "download_failed";
                    err = ESP_FAIL;
                } else if (!decrypt_ok && encrypted) { *err_code = "decrypt_auth_failed"; err = ESP_FAIL; }
            }
        }
        psa_hash_abort(&hash_op);
        if (aead_started) psa_aead_abort(&aead);
        if (aes_key != 0) (void)psa_destroy_key(aes_key);
        if (ota_started) esp_ota_abort(ota);
        esp_http_client_close(c); esp_http_client_cleanup(c);
        if (ok) { log_update_metrics("ota_verified"); return ESP_OK; }
        if (*err_code == NULL) *err_code = "download_failed";
        if (attempt + 1 < OTA_RETRY_COUNT) vTaskDelay(pdMS_TO_TICKS(500 * (attempt + 1)));
    }
    return ESP_FAIL;
}

static void handle_command(const char *data, size_t len)
{
    log_update_metrics("command_begin");
    static char manifest_buf[MANIFEST_MAX];
    char req[64], dev[32], target[16], ver[32], url[200] = {0}, issued[40], expires[40];
    char m_type[16], m_ver[32], m_min[32], m_url[200];
    const char *err_code = NULL;
    unsigned vn[3], vr[3], vh[3];
    uint32_t image_size = 0; uint8_t image_hash[32], image_nonce[12] = {0}, image_tag[16] = {0}; bool encrypted = false;
    const esp_partition_t *new_partition = NULL;
    time_t t_issued = 0, t_expires = 0, now;
    esp_app_desc_t rd;
    cJSON *mf = NULL;

    cJSON *root = cJSON_ParseWithLength(data, len);
    if (root == NULL) {
        ESP_LOGW(TAG, "Commande ignoree: JSON invalide");
        return;
    }

    /* Without a valid request_id we cannot even report: drop silently. */
    if (!json_str(root, "request_id", req, sizeof req) || !valid_token(req, sizeof req)) {
        ESP_LOGW(TAG, "Commande ignoree: request_id absent ou invalide");
        goto done;
    }
    bool replayed = false;
    if (!nvs_request_seen(req, &replayed)) { pub_status(req, "rejected", 0, "replay_state_failed", NULL); goto done; }
    if (replayed || strcmp(req, last_req) == 0) { pub_status(req, "rejected", 0, "replayed_request", NULL); goto done; }
    if (!nvs_record_request(req)) { pub_status(req, "rejected", 0, "replay_state_failed", NULL); goto done; }
    snprintf(last_req, sizeof last_req, "%s", req);
    pub_status(req, "received", 0, NULL, NULL);

    if (!json_str(root, "device_id", dev, sizeof dev) || strcmp(dev, DEVICE_ID) != 0) {
        pub_status(req, "rejected", 0, "wrong_device", NULL); goto done;
    }
    if (!json_str(root, "target", target, sizeof target) || strcmp(target, DEVICE_TARGET) != 0) {
        pub_status(req, "rejected", 0, "wrong_target", NULL); goto done;
    }
    if (!json_str(root, "version", ver, sizeof ver) || !parse_semver(ver, vn)) {
        pub_status(req, "rejected", 0, "bad_version", NULL); goto done;
    }
    if (!json_str(root, "manifest_url", url, sizeof url) || !trusted_fw_url(url, ver)) {
        log_untrusted_fw_url(url);
        pub_status(req, "rejected", 0, "untrusted_url", ver); goto done;
    }

    /* Expiry and replay window: needs a trustworthy clock, otherwise fail closed. */
    if (!time_ok()) {
        pub_status(req, "rejected", 0, "time_not_synced", ver); goto done;
    }
    if (!json_str(root, "issued_at", issued, sizeof issued) || !parse_iso(issued, &t_issued) ||
        !json_str(root, "expires_at", expires, sizeof expires) || !parse_iso(expires, &t_expires)) {
        pub_status(req, "rejected", 0, "bad_timestamps", ver); goto done;
    }
    now = time(NULL);
    if (now > t_expires)               { pub_status(req, "rejected", 0, "command_expired", ver);  goto done; }
    if (t_issued > now + 300)          { pub_status(req, "rejected", 0, "issued_in_future", ver); goto done; }
    if (t_expires - t_issued > 3600)   { pub_status(req, "rejected", 0, "ttl_too_long", ver);     goto done; }

    /* Software anti-rollback: only strictly newer versions are accepted. */
    if (!running_desc(&rd) || !parse_semver(rd.version, vr)) {
        pub_status(req, "rejected", 0, "running_version_unknown", ver); goto done;
    }
    bool have_highwater = false;
    if (!nvs_get_highwater(vh, &have_highwater)) { pub_status(req, "rejected", 0, "rollback_state_failed", ver); goto done; }
    const unsigned *floor = have_highwater && cmp_semver(vh, vr) > 0 ? vh : vr;
    if (cmp_semver(vn, floor) <= 0) { pub_status(req, "rejected", 0, "version_not_newer", ver); goto done; }

    /* ---- manifest ---- */
    pub_status(req, "downloading", 0, NULL, ver);
    log_update_metrics("before_manifest_fetch");
    bool manifest_ok = false;
    for (int attempt = 0; attempt < OTA_RETRY_COUNT && !manifest_ok; attempt++) {
        manifest_ok = fetch_manifest(url, manifest_buf, sizeof manifest_buf);
        if (!manifest_ok && attempt + 1 < OTA_RETRY_COUNT) vTaskDelay(pdMS_TO_TICKS(500 * (attempt + 1)));
    }
    if (!manifest_ok) { pub_status(req, "failed", 0, "manifest_fetch_failed", ver); goto done; }
    mf = cJSON_Parse(manifest_buf);
    if (mf == NULL || !json_str(mf, "device_type", m_type, sizeof m_type) ||
        !json_str(mf, "version", m_ver, sizeof m_ver)) {
        pub_status(req, "failed", 0, "manifest_invalid", ver); goto done;
    }
    /* The firmware URL is derived from the trusted command URL (same directory,
     * firmware.bin). The manifest "url" field is not signed, so it is not used. */
    {
        static const char SUFFIX[] = "manifest.json";
        size_t ul = strlen(url), sl = sizeof(SUFFIX) - 1;
        if (ul < sl || strcmp(url + ul - sl, SUFFIX) != 0 || ul - sl + strlen("firmware.bin") >= sizeof m_url) {
            pub_status(req, "rejected", 0, "bad_manifest_url", ver); goto done;
        }
        memcpy(m_url, url, ul - sl);
        strcpy(m_url + ul - sl, "firmware.bin");
    }
    if (strcmp(m_type, DEVICE_TARGET) != 0) { pub_status(req, "rejected", 0, "manifest_wrong_target", ver); goto done; }
    if (!trusted_fw_url(m_url, m_ver)) {
        pub_status(req, "rejected", 0, "untrusted_url", ver); goto done;
    }
    cJSON *encrypted_field = cJSON_GetObjectItemCaseSensitive(mf, "encrypted");
    char sig_alg[48]; uint32_t declared_size = 0;
    const esp_partition_t *slot = esp_ota_get_next_update_partition(NULL);
    if (!json_str(mf, "signature_alg", sig_alg, sizeof sig_alg) || strcmp(sig_alg, "ECDSA-P256-SHA256-P1363") != 0) {
        pub_status(req, "rejected", 0, "bad_signature_alg", ver); goto done;
    }
    if (!json_int(mf, "size", &declared_size) || slot == NULL || declared_size > slot->size) {
        pub_status(req, "rejected", 0, "size_invalid", ver); goto done;
    }
    unsigned manifest_version[3], floor_manifest[3];
    if (!parse_semver(m_ver, manifest_version) || !json_str(mf, "min_version", m_min, sizeof m_min) ||
        !parse_semver(m_min, floor_manifest) || cmp_semver(floor_manifest, manifest_version) > 0) {
        pub_status(req, "rejected", 0, "manifest_invalid", ver); goto done;
    }
    if (!json_str(mf, "device_type", m_type, sizeof m_type) || !cJSON_IsBool(encrypted_field) ||
        !verify_manifest(mf, m_type, m_ver, m_min, sizeof m_min, &image_size, image_hash, &encrypted, image_nonce, image_tag)) {
        pub_status(req, "rejected", 0, "signature_invalid", ver); goto done;
    }
    if (strcmp(m_ver, ver) != 0) { pub_status(req, "rejected", 0, "manifest_version_mismatch", ver); goto done; }
    if (cmp_semver(floor, floor_manifest) < 0) {
        pub_status(req, "rejected", 0, "min_version_not_met", ver); goto done;
    }
#if !OTA_HAS_DEV_AES_KEY
    if (encrypted) { pub_status(req, "rejected", 0, "encrypted_not_supported_yet", ver); goto done; }
#endif

    /* ---- download, hash, validate, persist pending, then select boot slot ---- */
    if (do_ota(m_url, req, ver, image_size, image_hash, encrypted, image_nonce, image_tag, &new_partition, &err_code) != ESP_OK) {
        pub_status(req, "failed", 0, err_code, ver); goto done;
    }
    pub_status(req, "installing", 100, NULL, ver);
    if (!nvs_set_pending(req, ver)) {
        pub_status(req, "failed", 0, "pending_state_failed", ver); goto done;
    }
    if (esp_ota_set_boot_partition(new_partition) != ESP_OK) {
        (void)nvs_clear_pending(); pub_status(req, "failed", 0, "install_failed", ver); goto done;
    }
    pub_status(req, "rebooting", 100, NULL, ver);
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();

done:
    if (mf) cJSON_Delete(mf);
    cJSON_Delete(root);
}

static void update_task(void *arg)
{
    static cmd_msg_t m;
    for (;;) {
        if (xQueueReceive(update_queue, &m, portMAX_DELAY) == pdTRUE) {
            log_update_metrics("command_dequeued");
            handle_command(m.data, m.len);
        }
    }
}

/* ============================================== rollback / confirmation */
static bool confirm_app(void)
{
    esp_err_t e = esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "Application confirmee (rollback annule): %s", esp_err_to_name(e));
    app_confirmed = (e == ESP_OK);
    return app_confirmed;
}

/* Runs once, when MQTT is connected after boot. */
static void boot_check(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    if (run == NULL || esp_ota_get_state_partition(run, &st) != ESP_OK) st = ESP_OTA_IMG_UNDEFINED;

    esp_app_desc_t d;
    char run_ver[32] = "";
    if (running_desc(&d)) snprintf(run_ver, sizeof run_ver, "%s", d.version);

    char req[64], ver[32];
    if (nvs_get_pending(req, sizeof req, ver, sizeof ver)) {
        if (strcmp(ver, run_ver) == 0) {
            if (st == ESP_OTA_IMG_PENDING_VERIFY && !confirm_app()) {
                pub_status(req, "failed", 100, "new_app_not_confirmed", ver);
            } else if (!nvs_set_highwater(ver)) {
                ESP_LOGE(TAG, "Anti-rollback version persistence failed");
                pub_status(req, "failed", 100, "rollback_state_failed", ver);
            } else pub_status(req, "success", 100, NULL, ver);
        } else {
            /* The update was started but the old application is running: it was rolled back. */
            pub_status(req, "rolled_back", 100, "new_app_not_confirmed", ver);
        }
        if (!nvs_clear_pending()) ESP_LOGE(TAG, "Could not clear pending OTA state");
    } else if (st == ESP_OTA_IMG_PENDING_VERIFY) {
        confirm_app();
    }
    boot_check_done = true;
}

/* Health check: a new application that does not reach the broker in time is rejected. */
static void health_task(void *arg)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    if (run == NULL || esp_ota_get_state_partition(run, &st) != ESP_OK ||
        st != ESP_OTA_IMG_PENDING_VERIFY) {
        vTaskDelete(NULL);
        return;
    }
    ESP_LOGW(TAG, "Nouvelle application a valider (health check %d s)", HEALTH_TIMEOUT_S);
    for (int i = 0; i < HEALTH_TIMEOUT_S; i++) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (app_confirmed) {
            vTaskDelete(NULL);
            return;
        }
    }
    ESP_LOGE(TAG, "Health check echoue: retour a l'application precedente");
    esp_ota_mark_app_invalid_rollback_and_reboot();
    vTaskDelete(NULL);
}

/* ================================================================== MQTT */
static void mqtt_event_handler(void *handler_args, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;

    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        mqtt_connected = true;
        ESP_LOGI(TAG, "MQTT connecte (TLS ok, broker authentifie)");
        esp_mqtt_client_subscribe_single(event->client, TOPIC_UPDATE_CMD, 1);
        break;

    case MQTT_EVENT_DISCONNECTED:
        mqtt_connected = false;
        ESP_LOGW(TAG, "MQTT deconnecte (reconnexion automatique)");
        break;

    case MQTT_EVENT_DATA:
        /* Only complete, bounded messages on the command topic are queued.
         * A command is a REQUEST: all checks happen in handle_command(). */
        if (event->topic != NULL && event->topic_len == (int)strlen(TOPIC_UPDATE_CMD) &&
            memcmp(event->topic, TOPIC_UPDATE_CMD, event->topic_len) == 0) {
            if (event->data == NULL || event->data_len <= 0 || event->total_data_len != event->data_len || event->data_len >= CMD_MAX) {
                ESP_LOGW(TAG, "Commande trop grande ou fragmentee: ignoree");
            } else {
                cmd_msg_t m;
                m.len = event->data_len;
                memcpy(m.data, event->data, event->data_len);
                m.data[m.len] = '\0';
                if (xQueueSend(update_queue, &m, 0) != pdTRUE) {
                    ESP_LOGW(TAG, "File de commandes pleine: commande ignoree");
                }
            }
        }
        break;

    case MQTT_EVENT_ERROR:
        ESP_LOGE(TAG, "MQTT erreur (type %d)",
                 event->error_handle ? event->error_handle->error_type : -1);
        if (event->error_handle &&
            event->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
            ESP_LOGE(TAG, "Connexion refusee par le broker (code %d)",
                     event->error_handle->connect_return_code);
        }
        break;

    default:
        break;
    }
}

static void mqtt_task(void *arg)
{
    xEventGroupWaitBits(wifi_events, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, portMAX_DELAY);

    /* Clock for the expiry checks (the router must reach an NTP server). */
    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_err_t se = esp_netif_sntp_init(&sntp);
    ESP_LOGI(TAG, "SNTP: %s", esp_err_to_name(se));

    if (SIMULATE_BAD_FIRMWARE) {
        ESP_LOGE(TAG, "SIMULATE_BAD_FIRMWARE: MQTT jamais demarre (test de rollback)");
        for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
    }

    static char mqtt_uri[128];
    if (!build_mqtt_uri(mqtt_uri, sizeof mqtt_uri)) {
        ESP_LOGE(TAG, "BACKEND_BASE_URL invalide; URI MQTT indisponible");
        vTaskDelete(NULL);
        return;
    }
    const esp_mqtt_client_config_t cfg = {
        .broker = {
            .address.uri = mqtt_uri,
            .verification.certificate = (const char *)ca_crt_start,
        },
        .credentials = {
            .username = MQTT_USER,
            .client_id = DEVICE_ID,
            .authentication.password = MQTT_PASS,
        },
        .session.keepalive = 30,
    };
    mqtt_client = esp_mqtt_client_init(&cfg);
    if (mqtt_client == NULL) {
        ESP_LOGE(TAG, "esp_mqtt_client_init a echoue");
        vTaskDelete(NULL);
        return;
    }
    ESP_ERROR_CHECK(esp_mqtt_client_register_event(mqtt_client, ESP_EVENT_ANY_ID,
                                                   mqtt_event_handler, NULL));
    ESP_ERROR_CHECK(esp_mqtt_client_start(mqtt_client));

    char payload[192];
    int64_t last_status_s = -STATUS_PERIOD_S;
    for (;;) {
        if (mqtt_connected) {
            if (!boot_check_done) boot_check();
            int64_t now_s = esp_timer_get_time() / 1000000;
            if (now_s - last_status_s >= STATUS_PERIOD_S) {
                last_status_s = now_s;
                build_status_json(payload, sizeof payload);
                int id = esp_mqtt_client_publish(mqtt_client, TOPIC_STATUS, payload, 0, 1, 0);
                ESP_LOGI(TAG, "Statut publie (msg_id=%d)", id);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

/* ================================================================== main */
static void set_demo_led_for_version(const char *version)
{
    const uint64_t led_mask = (1ULL << 23) | (1ULL << 22) | (1ULL << 21);
    const gpio_config_t led_config = {
        .pin_bit_mask = led_mask,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&led_config) != ESP_OK) {
        ESP_LOGW(TAG, "Demo RGB LED GPIO setup failed");
        return;
    }

    unsigned running[3], green_release[3], blue_release[3];
    bool version_ok = parse_semver(version, running) && parse_semver("1.8.28", green_release) &&
                      parse_semver("1.8.29", blue_release);
    bool show_blue = version_ok && cmp_semver(running, blue_release) >= 0;
    bool show_green = version_ok && !show_blue && cmp_semver(running, green_release) >= 0;
    /* Common-cathode LED: GPIO high turns a color channel on. Wiring: R=23, G=22, B=21. */
    gpio_set_level(GPIO_NUM_23, (!show_green && !show_blue) ? 1 : 0);
    gpio_set_level(GPIO_NUM_22, show_green ? 1 : 0);
    gpio_set_level(GPIO_NUM_21, show_blue ? 1 : 0);
    ESP_LOGI(TAG, "Demo RGB LED: %s", show_blue ? "blue" : show_green ? "green" : "red");
}

void app_main(void)
{
    if (psa_crypto_init() != PSA_SUCCESS) { ESP_LOGE(TAG, "PSA Crypto initialization failed"); abort(); }
    esp_err_t r = nvs_flash_init();
    /* Never erase NVS on recovery: replay and anti-rollback state must survive. */
    if (r != ESP_OK) { ESP_LOGE(TAG, "NVS initialization failed; refusing OTA state reset"); abort(); }

    setenv("TZ", "UTC0", 1);     /* all timestamps are UTC */
    tzset();

    esp_app_desc_t d;
    if (running_desc(&d)) {
        ESP_LOGI(TAG, "Application %s version %s", d.project_name, d.version);
        set_demo_led_for_version(d.version);
    }

    wifi_events = xEventGroupCreate();
    update_queue = xQueueCreate(2, sizeof(cmd_msg_t));
    if (wifi_events == NULL || update_queue == NULL) {
        ESP_LOGE(TAG, "Failed to allocate OTA synchronization objects");
        abort();
    }
    if (xTaskCreate(network_task, "NetworkTask", 4096, NULL, 5, NULL) != pdPASS ||
        xTaskCreate(mqtt_task, "MqttTask", 6144, NULL, 4, NULL) != pdPASS ||
        xTaskCreate(update_task, "UpdateTask", 14336, NULL, 3, NULL) != pdPASS ||
        xTaskCreate(health_task, "HealthTask", 3072, NULL, 2, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Failed to create required OTA task");
        abort();
    }
}

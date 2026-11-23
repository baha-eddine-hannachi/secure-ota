$ErrorActionPreference = 'Stop'
$settings = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\.env')) {
  if ($line -match '^\s*([^#=]+)=(.*)$') { $settings[$matches[1].Trim()] = $matches[2].Trim().Trim('"').Trim("'") }
}
$port = $settings['HTTP_PORT']
$base = "https://10.210.189.35:$port"
$ca = $settings['MQTT_CA_PATH']
$token = $settings['ADMIN_API_TOKEN']

function Invoke-CurlCode([string[]]$Arguments) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $response = & curl.exe @Arguments 2>$null
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  $lines = @($response)
  $httpCode = if ($lines.Count) { $lines[-1] } else { '' }
  $body = if ($lines.Count -gt 1) { $lines[0..($lines.Count - 2)] -join "`n" } else { '' }
  return @{ code = $exitCode; http = $httpCode; body = $body }
}

$health = Invoke-CurlCode @('--silent','--show-error','--max-time','5','--ssl-no-revoke','--cacert',$ca,'-w',"`n%{http_code}","$base/api/health")
if ($health.code -ne 0) { throw 'TLS-verified health request failed' }
$healthJson = $health.body | ConvertFrom-Json
"A2 health_http=$($health.http) status=$($healthJson.status) mqtt_connected=$($healthJson.mqtt_connected)"

$stale = Invoke-CurlCode @('--silent','--show-error','--max-time','5','--ssl-no-revoke','--cacert',$ca,'-H',"Authorization: Bearer $token",'-w',"`n%{http_code}","$base/api/updates/4fdf59c2-2a19-46fd-a5fa-bccb9921a14f")
if ($stale.code -ne 0) { throw 'TLS-verified update GET failed' }
$staleJson = $stale.body | ConvertFrom-Json
"E3_live_get http=$($stale.http) state=$($staleJson.update.state)"

$device = Invoke-CurlCode @('--silent','--show-error','--max-time','5','--ssl-no-revoke','--cacert',$ca,'-H',"Authorization: Bearer $token",'-w',"`n%{http_code}","$base/api/devices/esp32-001")
if ($device.code -ne 0) { throw 'TLS-verified device GET failed' }
$deviceJson = $device.body | ConvertFrom-Json
"D4_live_device_get http=$($device.http) device_id=$($deviceJson.device.device_id) target=$($deviceJson.device.target) version=$($deviceJson.device.version)"

foreach ($protocol in @('1.0','1.1')) {
  $probe = Invoke-CurlCode @('--silent','--show-error','--max-time','5','--ssl-no-revoke','--cacert',$ca,'--tlsv1.0','--tls-max',$protocol,'-o','NUL','-w','%{http_code}',"$base/api/health")
  "A3_tls_max_$protocol curl_exit=$($probe.code) http=$($probe.body)"
}
$wrongHost = Invoke-CurlCode @('--silent','--show-error','--max-time','5','--ssl-no-revoke','--cacert',$ca,'--resolve',"wrong-host:$port`:10.210.189.35",'-o','NUL','-w','%{http_code}',"https://wrong-host:$port/api/health")
"A3_wrong_hostname curl_exit=$($wrongHost.code)"
$untrusted = Invoke-CurlCode @('--silent','--show-error','--max-time','5','--ssl-no-revoke','--cacert',$settings['TLS_CERT_PATH'],'-o','NUL','-w','%{http_code}',"$base/api/health")
"A3_untrusted_leaf_as_ca curl_exit=$($untrusted.code)"
$plain = Invoke-CurlCode @('--silent','--show-error','--max-time','5','-o','NUL','-w','%{http_code}',"http://10.210.189.35:$port/api/health")
"A3_plain_http curl_exit=$($plain.code) http=$($plain.body)"

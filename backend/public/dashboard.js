(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const tokenInput = $('admin-token');
  const loginForm = $('login-form');
  const notice = $('notice');
  const app = $('dashboard-app');
  const logout = $('logout');
  let adminToken = '';
  let snapshot = null;
  let results = [];
  let securityEvents = [];
  let timer = 0;
  let busy = false;
  let selectedUpdate = '';
  let selectedTest = '';
  let pendingFirmware = null;

  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const reset = (node) => node.replaceChildren();
  const date = (value) => value ? new Date(value).toLocaleString('fr-FR') : '—';
  const stateName = (value) => ({ created: 'Créée', sent: 'Envoyée', received: 'Reçue', downloading: 'Téléchargement', verifying: 'Vérification', installing: 'Installation', rebooting: 'Redémarrage', success: 'Réussie', failed: 'Échec', rolled_back: 'Rollback', rejected: 'Rejetée', expired: 'Expirée' }[value] ?? value ?? 'Inconnu');
  const statusName = (value) => ({ PASS: 'PASS', FAIL: 'FAIL', NOT_RUN: 'NON EXÉCUTÉ', BLOCKED: 'BLOQUÉ' }[value] ?? value);
  const pill = (value, label = value) => el('span', `${label}`, `pill status-${String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '')}`);
  const errorMessage = (error) => error?.message || 'Une erreur est survenue.';
  const versionIsNewer = (candidate, current) => {
    const a = String(candidate).split('.').map(Number); const b = String(current || '0.0.0').split('.').map(Number);
    if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((n) => !Number.isInteger(n))) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };

  async function api(url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' }, cache: 'no-store' });
    if (response.status === 401) {
      clearSession('Session expirée ou jeton refusé. Saisissez à nouveau votre jeton.');
      throw new Error('Authentification requise.');
    }
    if (!response.ok) {
      let message = `Erreur HTTP ${response.status}`;
      try { const body = await response.json(); message = body?.error?.message || message; } catch { /* ignore malformed error response */ }
      throw new Error(message);
    }
    return response.json();
  }

  async function apiPost(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { clearSession('Session expirée ou jeton refusé.'); throw new Error('Authentification requise.'); }
    if (!response.ok) {
      const detail = data?.error;
      throw new Error([detail?.code, detail?.message].filter(Boolean).join(': ') || `Erreur HTTP ${response.status}`);
    }
    return data;
  }

  function clearSession(message) {
    adminToken = '';
    snapshot = null;
    results = [];
    window.clearTimeout(timer);
    app.hidden = true;
    logout.hidden = true;
    notice.hidden = false;
    notice.textContent = message;
  }

  async function renderOverview() {
    const cards = $('overview-cards');
    reset(cards);
    const card = (title, value, detail, status) => {
      const box = el('section', undefined, 'metric-card');
      box.append(el('h2', title));
      const valueNode = el('p', value, 'metric-value');
      if (status) valueNode.append(document.createTextNode(` ${statusName(status)}`));
      box.append(valueNode, el('p', detail, 'metric-label'));
      cards.append(box);
    };
    card('Backend HTTPS', 'Disponible', `Actualisé ${date(snapshot.server_time)}`, 'PASS');
    card('Broker MQTT', snapshot.broker_connected ? 'Connecté' : 'Déconnecté', 'Connexion TLS configurée côté serveur', snapshot.broker_connected ? 'online' : 'offline');
    card('Appareils', String(snapshot.counts.devices), `${snapshot.devices.filter((d) => d.online).length} en ligne`, 'PASS');
    card('Mises à jour actives', String(snapshot.counts.active_updates), `${snapshot.counts.updates} au total`, snapshot.counts.active_updates ? 'warning' : 'PASS');

    const active = $('active-update');
    reset(active);
    if (!snapshot.active_updates.length) {
      active.append(el('p', 'Aucune mise à jour active.'));
      const latest = snapshot.updates[0];
      if (latest) active.append(el('p', `Dernière mise à jour : ${latest.device_id} · ${latest.version} · ${stateName(latest.state)} · ${latest.progress ?? 0}% · erreur ${latest.error_code ?? '—'}`));
    }
    else {
      for (const update of snapshot.active_updates) {
        const section = el('article', undefined, 'event');
        section.append(el('p', `${update.device_id} · ${update.version} · ${stateName(update.state)}`), el('p', `Requête ${update.request_id}`));
        const progress = document.createElement('progress');
        progress.max = 100;
        progress.value = update.progress ?? (['verifying', 'installing', 'rebooting', 'success'].includes(update.state) ? 100 : 0);
        progress.setAttribute('aria-label', `Progression de ${stateName(update.state)}`);
        section.append(progress, el('p', `Erreur : ${update.error_code ?? '—'}`));
        const timeline = el('div', undefined, 'timeline');
        const stages = ['created', 'sent', 'received', 'downloading', 'verifying', 'installing', 'rebooting', 'success'];
        const detail = await api(`/api/updates/${encodeURIComponent(update.request_id)}`).catch(() => null);
        const reached = new Set((detail?.update?.history ?? []).map((entry) => entry.state));
        for (const stage of stages) timeline.append(el('span', stateName(stage), reached.has(stage) || stage === update.state ? 'reached' : ''));
        section.append(timeline);
        active.append(section);
      }
    }

    const devices = el('section', undefined, 'panel');
    devices.append(el('h2', 'Appareils suivis'));
    if (!snapshot.devices.length) devices.append(el('p', 'Aucun appareil enregistré.'));
    for (const device of snapshot.devices) {
      const row = el('p', `${device.device_id} · ${device.target ?? 'cible inconnue'} · ${device.version ?? 'version inconnue'} · ${device.online ? 'En ligne' : 'Hors ligne'} · dernière activité ${date(device.last_seen)} · durée ${device.uptime_s ?? '—'} s`);
      devices.append(row);
    }
    active.append(devices);
  }

  function renderUpdates() {
    const body = $('updates-body');
    reset(body);
    for (const update of snapshot.updates) {
      const row = document.createElement('tr');
      const duration = Math.max(0, Date.parse(update.updated_at) - Date.parse(update.created_at));
      for (const value of [date(update.created_at), update.device_id, update.version]) row.append(el('td', value));
      const state = document.createElement('td'); state.append(pill(update.state, stateName(update.state))); row.append(state);
      row.append(el('td', `${Math.floor(duration / 1000)} s`), el('td', update.error_code ?? '—'));
      const actionCell = document.createElement('td');
      const button = el('button', 'Historique'); button.type = 'button'; button.addEventListener('click', () => showUpdate(update.request_id));
      actionCell.append(button); row.append(actionCell); body.append(row);
    }
    if (!snapshot.updates.length) { const row = document.createElement('tr'); const cell = el('td', 'Aucune mise à jour enregistrée.'); cell.colSpan = 7; row.append(cell); body.append(row); }
  }

  async function showUpdate(id) {
    selectedUpdate = id;
    const target = $('update-detail');
    reset(target);
    try {
      const { update } = await api(`/api/updates/${encodeURIComponent(id)}`);
      target.append(el('h3', `Historique · ${update.device_id} · ${update.version}`));
      const timeline = el('ol');
      for (const entry of update.history ?? []) timeline.append(el('li', `${stateName(entry.state)} · ${date(entry.timestamp)}${entry.error_code ? ` · ${entry.error_code}` : ''}`));
      target.append(timeline);
      if (update.error_code) target.append(el('p', `Erreur : ${update.error_code} — ${({ version_not_newer: 'La version demandée doit être plus récente que la version installée.', untrusted_url: 'L’URL ne correspond pas à l’adresse HTTPS approuvée par le firmware.', signature_invalid: 'La signature du manifeste n’a pas été validée.', hash_mismatch: 'Le hachage du firmware téléchargé ne correspond pas au manifeste.', new_app_not_confirmed: 'Le nouveau firmware n’a pas passé son contrôle de santé et le démarrage a été annulé.', command_expired: 'La commande OTA a expiré avant sa confirmation.' })[update.error_code] ?? 'Consultez le moniteur série et les événements de sécurité.'}`));
    } catch (error) { target.append(el('p', errorMessage(error))); }
  }

  function renderFirmwares() {
    const body = $('firmwares-body'); reset(body);
    const device = snapshot.devices.find((item) => item.target === 'esp32') ?? snapshot.devices[0];
    const active = snapshot.active_updates.some((item) => !device || item.device_id === device.device_id);
    for (const firmware of snapshot.firmwares) {
      const row = document.createElement('tr');
      for (const value of [firmware.device_type, firmware.version, `${firmware.size} octets`, firmware.sha256 ? `${firmware.sha256.slice(0, 12)}…` : '—', firmware.signature_alg ?? '—', firmware.deployed ? 'Déployé sur la carte' : 'Disponible', date(firmware.registered_at)]) row.append(el('td', value));
      const action = document.createElement('td'); const button = el('button', 'Déployer'); button.type = 'button';
      const reason = !device ? 'Aucun appareil connu' : !device.online ? 'Appareil hors ligne' : active ? 'Une mise à jour est déjà active' : firmware.deployed || !versionIsNewer(firmware.version, device.version) ? 'La version doit être plus récente' : '';
      button.disabled = Boolean(reason); if (reason) button.title = reason;
      button.addEventListener('click', () => openDeployDialog(firmware, device)); action.append(button);
      if (reason) action.append(el('small', reason, 'muted')); row.append(action);
      body.append(row);
    }
    if (!snapshot.firmwares.length) { const row = document.createElement('tr'); const cell = el('td', 'Aucun firmware enregistré.'); cell.colSpan = 8; row.append(cell); body.append(row); }
  }

  function openDeployDialog(firmware, device) {
    pendingFirmware = { firmware, device };
    reset($('deploy-summary'));
    $('deploy-summary').append(el('p', `${device.device_id} · ${device.version ?? 'inconnue'} → ${firmware.version}`), el('p', `${firmware.size} octets · ${firmware.signature_alg}`));
    $('deploy-dialog').showModal(); $('confirm-deploy').focus();
  }

  function renderSecurity() {
    const target = $('security-list'); reset(target);
    const severity = $('severity-filter').value;
    const events = securityEvents.filter((event) => !severity || event.severity === severity);
    if (!events.length) target.append(el('p', 'Aucun événement pour ce filtre.'));
    for (const event of events) {
      const item = el('article', undefined, 'event');
      item.append(el('p', `${date(event.timestamp)} · ${event.type} · ${event.device_id ?? 'système'}`));
      item.append(pill(event.severity, event.severity));
      const details = el('pre', JSON.stringify(event.details ?? {}, null, 2));
      item.append(details); target.append(item);
    }
  }

  function renderTests() {
    const counts = $('test-counts');
    const statusCounts = { PASS: 0, FAIL: 0, NOT_RUN: 0, BLOCKED: 0 };
    for (const result of results) statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    counts.textContent = `${statusCounts.PASS} réussis · ${statusCounts.FAIL} échecs · ${statusCounts.NOT_RUN} non exécutés · ${statusCounts.BLOCKED} bloqués · ${results.length}/14 enregistrés`;
    $('test-progress').value = statusCounts.PASS;
    const body = $('tests-body'); reset(body);
    for (const result of results) {
      const row = document.createElement('tr');
      row.append(el('td', result.id), el('td', result.title), el('td', result.stage));
      const state = document.createElement('td'); state.append(pill(result.status, statusName(result.status))); row.append(state);
      row.append(el('td', date(result.date)));
      const button = el('button', 'Détails'); button.type = 'button'; button.addEventListener('click', () => showTest(result.id));
      const action = document.createElement('td'); action.append(button); row.append(action); body.append(row);
    }
  }

  async function showTest(id) {
    selectedTest = id;
    const target = $('test-detail'); reset(target);
    try {
      const { result } = await api(`/api/test-results/${encodeURIComponent(id)}`);
      target.append(el('h3', `${result.id} · ${result.title}`));
      target.append(el('p', `${statusName(result.status)} · ${result.fw_from || '—'} → ${result.fw_to || '—'} · ${date(result.date)}`));
      target.append(el('p', result.summary));
      if (result.notes) target.append(el('p', result.notes));
      for (const observed of result.observed) target.append(el('p', `Observé : ${observed}`));
      for (const file of result.evidence) {
        target.append(el('h4', file.filename));
        target.append(el('pre', file.text, 'evidence'));
      }
    } catch (error) { target.append(el('p', errorMessage(error))); }
  }

  async function refresh() {
    if (!adminToken || busy) return;
    busy = true;
    try {
      const [overview, tests, security] = await Promise.all([api('/api/overview'), api('/api/test-results'), api('/api/security-events')]);
      snapshot = overview;
      results = tests.results;
      securityEvents = security.events;
      await renderOverview(); renderUpdates(); renderFirmwares(); renderSecurity(); renderTests();
      $('refresh-time').textContent = `Dernière actualisation : ${date(snapshot.server_time)}.`;
      notice.hidden = true;
      app.hidden = false;
      const active = snapshot.counts.active_updates > 0;
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, active ? 3000 : 10000);
      if (selectedUpdate && document.querySelector('#view-updates:not([hidden])')) await showUpdate(selectedUpdate);
      if (selectedTest && document.querySelector('#view-tests:not([hidden])')) await showTest(selectedTest);
    } catch (error) {
      if (adminToken) { notice.hidden = false; notice.textContent = errorMessage(error); }
      window.clearTimeout(timer); timer = window.setTimeout(refresh, 10000);
    } finally { busy = false; }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    adminToken = tokenInput.value;
    tokenInput.value = '';
    if (!adminToken) return;
    app.hidden = false;
    logout.hidden = false;
    notice.textContent = 'Chargement des données protégées…';
    await refresh();
  });
  logout.addEventListener('click', () => clearSession('Session fermée. Saisissez votre jeton pour continuer.'));
  $('refresh-now').addEventListener('click', () => { window.clearTimeout(timer); refresh(); });
  $('severity-filter').addEventListener('change', renderSecurity);
  $('scan-releases').addEventListener('click', async () => {
    const result = $('scan-results'); result.textContent = 'Recherche des releases…';
    try {
      const response = await apiPost('/api/releases/scan', {});
      result.textContent = response.results.map((item) => `${item.version}: ${item.result}${item.error_code ? ` (${item.error_code})` : ''}`).join(' · ') || 'Aucune release détectée.';
      await refresh();
    } catch (error) { result.textContent = errorMessage(error); }
  });
  $('confirm-deploy').addEventListener('click', async () => {
    if (!pendingFirmware) return;
    const { firmware, device } = pendingFirmware; const dialog = $('deploy-dialog');
    $('confirm-deploy').disabled = true;
    try {
      const { update } = await apiPost('/api/updates', { device_id: device.device_id, version: firmware.version, source: 'dashboard' });
      dialog.close(); pendingFirmware = null; selectedUpdate = update.request_id;
      document.querySelector('[data-view="updates"]').click(); await refresh();
    } catch (error) {
      const message = el('p', errorMessage(error), 'notice');
      message.setAttribute('role', 'alert');
      $('deploy-summary').append(message);
    }
    finally { $('confirm-deploy').disabled = false; }
  });
  document.querySelectorAll('[role="tab"]').forEach((tab, index, tabs) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); tabs[next].focus(); activateTab(tabs[next]);
    });
  });
  function activateTab(tab) {
    document.querySelectorAll('[role="tab"]').forEach((item) => { const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; });
    document.querySelectorAll('.view').forEach((view) => { view.hidden = view.id !== tab.getAttribute('aria-controls'); });
  }
  $('open-report').addEventListener('click', async () => {
    if (!adminToken) return;
    const reportWindow = window.open('about:blank', '_blank');
    if (!reportWindow) { notice.hidden = false; notice.textContent = 'Le navigateur a bloqué la fenêtre du rapport. Autorisez une fenêtre pour cette page puis réessayez.'; return; }
    reportWindow.opener = null;
    try {
      const response = await fetch('/api/test-report.html', { headers: { Authorization: `Bearer ${adminToken}` }, cache: 'no-store' });
      if (!response.ok) throw new Error(`Rapport indisponible (HTTP ${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      reportWindow.location.replace(url);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { reportWindow.close(); notice.hidden = false; notice.textContent = errorMessage(error); }
  });
})();

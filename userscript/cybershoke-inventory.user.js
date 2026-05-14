// ==UserScript==
// @name         Cybershoke Inventory Live
// @namespace    https://github.com/cybershoke-live
// @version      0.2.0
// @description  Показывает цены Steam-инвентарей всех игроков на сервере Cybershoke и общую сумму
// @author       you
// @match        https://cybershoke.net/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // === CONFIG ===
  const BACKEND_URL = localStorage.getItem('csli_backend') || 'http://localhost:3000';

  const log = (...a) => console.log('%c[csli]', 'color:#ff5722;font-weight:bold', ...a);

  // Expose setter so user can change backend URL from DevTools
  const setBackend = (url) => {
    localStorage.setItem('csli_backend', url);
    log('Backend URL set:', url, '— reload page to apply');
  };
  try { unsafeWindow.csliSetBackend = setBackend; } catch {}
  window.csliSetBackend = setBackend;

  // === Inserted styles ===
  const style = document.createElement('style');
  style.textContent = `
    .csli-badge {
      display: inline-block;
      padding: 1px 6px;
      margin-left: 6px;
      background: rgba(255,87,34,0.15);
      color: #ff7043;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      vertical-align: middle;
    }
    .csli-badge.private { background: rgba(120,120,120,0.15); color: #888; font-weight: 400; }
    .csli-badge.loading { background: rgba(120,120,120,0.15); color: #888; font-weight: 400; }
    .csli-badge.error { background: rgba(248,113,113,0.15); color: #f87171; }
    .csli-total-panel {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 99999;
      background: #15181d;
      border: 1px solid #ff5722;
      border-radius: 8px;
      padding: 12px 16px;
      color: #e6e9ee;
      font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      min-width: 220px;
    }
    .csli-total-panel .csli-label {
      font-size: 11px; color: #8a93a0;
      text-transform: uppercase; letter-spacing: 0.06em;
      margin-bottom: 4px;
    }
    .csli-total-panel .csli-value {
      font-size: 22px; font-weight: 600; color: #ff5722;
      font-variant-numeric: tabular-nums;
    }
    .csli-total-panel .csli-progress { font-size: 11px; color: #8a93a0; margin-top: 2px; }
    .csli-total-panel .csli-close {
      position: absolute; top: 4px; right: 8px;
      background: transparent; border: 0; color: #8a93a0;
      cursor: pointer; font-size: 16px; line-height: 1;
    }
    .csli-total-panel .csli-close:hover { color: #fff; }
  `;
  document.head.appendChild(style);

  // === State ===
  let currentServerKey = null;
  let panel = null;

  // === Backend call via GM_xmlhttpRequest (bypasses CORS) ===
  function postBatch(steamids) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: BACKEND_URL + '/api/inventory-batch',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ steamids }),
        timeout: 60000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
          } else {
            reject(new Error('HTTP ' + r.status + ': ' + (r.responseText || '').slice(0, 200)));
          }
        },
        onerror: () => reject(new Error('Network error reaching ' + BACKEND_URL)),
        ontimeout: () => reject(new Error('Backend timeout')),
      });
    });
  }

  // === UI: total panel ===
  function showPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'csli-total-panel';
    panel.innerHTML =
      '<button class="csli-close" title="Скрыть">×</button>' +
      '<div class="csli-label">Сумма инвентарей сервера</div>' +
      '<div class="csli-value" data-role="total">—</div>' +
      '<div class="csli-progress" data-role="progress"></div>';
    panel.querySelector('.csli-close').onclick = () => { panel.remove(); panel = null; };
    document.body.appendChild(panel);
  }
  function updatePanel(opts) {
    if (!panel) showPanel();
    if (opts.total != null) panel.querySelector('[data-role="total"]').textContent = '$' + opts.total.toFixed(2);
    if (opts.progress != null) panel.querySelector('[data-role="progress"]').textContent = opts.progress;
  }
  function hidePanel() {
    if (panel) { panel.remove(); panel = null; }
  }

  // === Fetch player list (same-origin, uses your Cybershoke session cookies) ===
  async function fetchServerPlayers(ip, port) {
    const r = await fetch('/api/servers/data', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'ip=' + encodeURIComponent(ip) + '&port=' + encodeURIComponent(port),
    });
    if (!r.ok) throw new Error('Cybershoke /api/servers/data: ' + r.status);
    const j = await r.json();
    return j.playersv2 || [];
  }

  // === Main handler when a server modal opens ===
  async function handleServerOpen(modal, ip, port) {
    const key = ip + ':' + port;
    if (currentServerKey === key) return;
    currentServerKey = key;
    log('Server opened:', key);

    showPanel();
    updatePanel({ total: 0, progress: 'Загрузка игроков…' });

    let players;
    try {
      players = await fetchServerPlayers(ip, port);
    } catch (e) {
      log('fetchServerPlayers error', e);
      updatePanel({ progress: 'Ошибка: ' + e.message });
      return;
    }
    const withIds = players.filter(p => p.steamid64);
    log(withIds.length + '/' + players.length + ' players have steamid64');

    if (withIds.length === 0) {
      updatePanel({ progress: 'Игроки без SteamID. Залогиньтесь на Cybershoke.' });
      return;
    }

    // Inject loading badges
    const badges = new Map();
    for (const p of withIds) {
      const b = injectBadge(modal, p.name);
      if (b) {
        b.textContent = '…';
        b.className = 'csli-badge loading';
        badges.set(p.steamid64, b);
      }
    }

    updatePanel({ progress: 'Запрос инвентарей (' + withIds.length + ')…' });

    let resp;
    try {
      resp = await postBatch(withIds.map(p => p.steamid64));
    } catch (e) {
      log('postBatch error', e);
      updatePanel({ progress: 'Backend ошибка: ' + e.message });
      return;
    }

    let priced = 0, priv = 0, errs = 0;
    for (const p of withIds) {
      const r = resp.results[p.steamid64];
      const b = badges.get(p.steamid64);
      if (!r) {
        if (b) { b.className = 'csli-badge error'; b.textContent = '?'; }
        continue;
      }
      if (r.is_private) {
        if (b) { b.className = 'csli-badge private'; b.textContent = '🔒'; }
        priv++;
      } else if (r.error) {
        if (b) { b.className = 'csli-badge error'; b.textContent = '!'; }
        errs++;
      } else {
        if (b) { b.className = 'csli-badge'; b.textContent = '$' + r.total_usd.toFixed(0); }
        priced++;
      }
    }

    updatePanel({
      total: resp.total_usd || 0,
      progress: priced + ' 💰 · ' + priv + ' 🔒 · ' + errs + ' ! · ' + withIds.length + ' всего',
    });
  }

  // === Find player nick in modal table and inject badge ===
  function injectBadge(modal, nick) {
    for (const td of modal.querySelectorAll('td')) {
      const text = (td.textContent || '').trim();
      // Take the first cell whose text exactly matches the nickname
      if (text === nick) {
        // Avoid duplicate
        let badge = td.querySelector('.csli-badge');
        if (badge) return badge;
        badge = document.createElement('span');
        badge.className = 'csli-badge loading';
        badge.textContent = '…';
        td.appendChild(badge);
        return badge;
      }
    }
    return null;
  }

  // === Extract IP:port from modal DOM ===
  // Modal text contains "IP 217.182.199.30:28015"
  function extractIpPort(modal) {
    const m = (modal.innerText || '').match(/IP\s+(\d{1,3}(?:\.\d{1,3}){3})[:\s]+(\d{1,5})/);
    return m ? { ip: m[1], port: m[2] } : null;
  }

  // === Watch for server modal appearing/disappearing ===
  let pendingTimer = null;
  function checkForModal() {
    const modal = document.querySelector('.modal__overlay_SERVER_MODAL');
    if (!modal) {
      if (currentServerKey) {
        log('Server modal closed');
        currentServerKey = null;
        hidePanel();
      }
      return;
    }
    // Wait briefly for IP and player list to render
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const ipPort = extractIpPort(modal);
      if (!ipPort) {
        log('Modal open but no IP found in DOM yet (will retry on next mutation)');
        return;
      }
      handleServerOpen(modal, ipPort.ip, ipPort.port);
    }, 600);
  }

  const observer = new MutationObserver(checkForModal);
  observer.observe(document.body, { childList: true, subtree: true });
  // Also check once on script load (in case modal is already open)
  checkForModal();

  log('Cybershoke Inventory Live ready. Backend:', BACKEND_URL);
  log('Change backend: csliSetBackend("https://your-app.vercel.app") or set localStorage.csli_backend');
})();

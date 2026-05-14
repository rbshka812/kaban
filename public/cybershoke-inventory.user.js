// ==UserScript==
// @name         Cybershoke Inventory Live
// @namespace    https://github.com/cybershoke-live
// @version      0.1.1
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
  // Change this to your deployed Vercel URL after `vercel deploy --prod`.
  // For local dev: 'http://localhost:3000'
  const BACKEND_URL = localStorage.getItem('csli_backend') || 'http://localhost:3000';

  const log = (...a) => console.log('%c[csli]', 'color:#ff5722;font-weight:bold', ...a);

  // Allow user to override backend URL from DevTools Console: csliSetBackend('https://...')
  // unsafeWindow exposes us to the page's main world so DevTools can see the function.
  const setBackend = (url) => {
    localStorage.setItem('csli_backend', url);
    log('Backend URL set:', url, '— reload page to apply');
  };
  try { unsafeWindow.csliSetBackend = setBackend; } catch {}
  // Also keep on sandbox window for safety
  window.csliSetBackend = setBackend;

  // === Styles for inserted UI ===
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
      font-size: 11px;
      color: #8a93a0;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 4px;
    }
    .csli-total-panel .csli-value {
      font-size: 22px;
      font-weight: 600;
      color: #ff5722;
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
  let currentServer = null; // { ip, port } of last opened
  let totalUsd = 0;
  let panel = null;

  // === Backend call via GM_xmlhttpRequest (bypasses CORS issues) ===
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
            reject(new Error(`HTTP ${r.status}: ${r.responseText?.slice(0, 200)}`));
          }
        },
        onerror: () => reject(new Error('Network error reaching backend ' + BACKEND_URL)),
        ontimeout: () => reject(new Error('Backend timeout')),
      });
    });
  }

  // === UI: total panel ===
  function showPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.className = 'csli-total-panel';
    panel.innerHTML = `
      <button class="csli-close" title="Скрыть">×</button>
      <div class="csli-label">Сумма инвентарей сервера</div>
      <div class="csli-value" data-role="total">—</div>
      <div class="csli-progress" data-role="progress"></div>
    `;
    panel.querySelector('.csli-close').onclick = () => { panel.remove(); panel = null; };
    document.body.appendChild(panel);
  }
  function updatePanel({ total, progress }) {
    if (!panel) showPanel();
    if (total != null) panel.querySelector('[data-role="total"]').textContent = '$' + total.toFixed(2);
    if (progress != null) panel.querySelector('[data-role="progress"]').textContent = progress;
  }

  // === Probe Cybershoke API: get current server players ===
  async function fetchServerPlayers(ip, port) {
    const r = await fetch('/api/servers/data', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}`,
    });
    if (!r.ok) throw new Error('Cybershoke /api/servers/data: ' + r.status);
    const j = await r.json();
    return j.playersv2 || [];
  }

  // === Main: when a server modal opens, find IP:port, fetch players, fetch inventories ===
  async function handleServerOpen(ip, port) {
    if (currentServer && currentServer.ip === ip && currentServer.port === port) return;
    currentServer = { ip, port };
    log('Server opened:', ip + ':' + port);

    totalUsd = 0;
    showPanel();
    updatePanel({ total: 0, progress: 'Загрузка игроков…' });

    let players;
    try {
      players = await fetchServerPlayers(ip, port);
    } catch (e) {
      updatePanel({ progress: 'Ошибка: ' + e.message });
      return;
    }
    const withIds = players.filter(p => p.steamid64);
    log(`${withIds.length}/${players.length} players have steamid64`);

    if (!withIds.length) {
      updatePanel({ progress: 'У игроков нет SteamID. Залогиньтесь на Cybershoke.' });
      return;
    }

    // Inject loading badges next to nicks in the modal
    const badgesByNick = new Map();
    for (const p of withIds) {
      const badge = injectBadge(p.name);
      if (badge) {
        badge.textContent = '…';
        badge.className = 'csli-badge loading';
        badgesByNick.set(p.steamid64, badge);
      }
    }

    updatePanel({ progress: `Запрос инвентарей (${withIds.length})…` });

    let resp;
    try {
      resp = await postBatch(withIds.map(p => p.steamid64));
    } catch (e) {
      updatePanel({ progress: 'Backend ошибка: ' + e.message });
      return;
    }

    let priced = 0;
    let priv = 0;
    let errs = 0;
    for (const p of withIds) {
      const r = resp.results[p.steamid64];
      const badge = badgesByNick.get(p.steamid64);
      if (!r) {
        if (badge) { badge.className = 'csli-badge error'; badge.textContent = '?'; }
        continue;
      }
      if (r.is_private) {
        if (badge) { badge.className = 'csli-badge private'; badge.textContent = '🔒'; }
        priv++;
      } else if (r.error) {
        if (badge) { badge.className = 'csli-badge error'; badge.textContent = '!'; }
        errs++;
      } else {
        if (badge) { badge.className = 'csli-badge'; badge.textContent = '$' + r.total_usd.toFixed(0); }
        priced++;
      }
    }

    updatePanel({
      total: resp.total_usd || 0,
      progress: `${priced} 💰 · ${priv} 🔒 · ${errs} ! · ${withIds.length} всего`,
    });
  }

  // === Insert a badge next to a player nick in the open server modal ===
  function injectBadge(nick) {
    const modal = document.querySelector('.modal__overlay_SERVER_MODAL');
    if (!modal) return null;
    // Player nicks render in TRs within the modal
    for (const tr of modal.querySelectorAll('tr')) {
      const cells = tr.querySelectorAll('td');
      if (!cells.length) continue;
      const cellText = cells[0]?.innerText?.trim() || '';
      if (cellText === nick) {
        // Avoid duplicate badge
        if (cells[0].querySelector('.csli-badge')) return cells[0].querySelector('.csli-badge');
        const badge = document.createElement('span');
        badge.className = 'csli-badge loading';
        badge.textContent = '…';
        cells[0].appendChild(badge);
        return badge;
      }
    }
    return null;
  }

  // === Detect server modal opening ===
  // The React app doesn't expose the IP/port in DOM directly. We hook fetch
  // to detect when /api/servers/data is POSTed and capture the body.
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const r = await _origFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
      if (url.includes('/api/servers/data') && args[1]?.method === 'POST') {
        const body = args[1].body || '';
        const m = body.match(/ip=([^&]+)&port=(\d+)/);
        if (m) {
          const ip = decodeURIComponent(m[1]);
          const port = m[2];
          setTimeout(() => handleServerOpen(ip, port), 400);
        }
      }
    } catch {}
    return r;
  };

  log('Cybershoke Inventory Live ready. Backend:', BACKEND_URL);
  log('Change backend: csliSetBackend("https://your-app.vercel.app")');
})();

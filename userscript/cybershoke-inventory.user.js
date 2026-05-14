// ==UserScript==
// @name         Cybershoke Inventory Live
// @namespace    https://github.com/cybershoke-live
// @version      0.3.1
// @description  Показывает цены Steam-инвентарей всех игроков на сервере Cybershoke и общую сумму
// @author       you
// @match        https://cybershoke.net/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      steamcommunity.com
// @connect      api.skinport.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // === CONFIG ===
  const PRICE_CACHE_KEY  = 'csli_prices_v1';
  const PRICE_TTL_MS     = 60 * 60 * 1000; // 1h
  const INV_CACHE_PREFIX = 'csli_inv_v1_';
  const INV_TTL_MS       = 60 * 60 * 1000; // 1h
  const STEAM_CONCURRENCY = 3;

  const log = (...a) => console.log('%c[csli]', 'color:#ff5722;font-weight:bold', ...a);

  // Expose cache-clear helper to DevTools
  const clearCache = () => {
    let n = 0;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('csli_')) { localStorage.removeItem(k); n++; }
    }
    log('Cleared ' + n + ' cache entries. Reload page to refetch.');
  };
  try { unsafeWindow.csliClearCache = clearCache; } catch {}
  window.csliClearCache = clearCache;

  // === LocalStorage cache helpers (with TTL) ===
  function readCache(key, ttlMs) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { v, t } = JSON.parse(raw);
      if (Date.now() - t > ttlMs) { localStorage.removeItem(key); return null; }
      return v;
    } catch { return null; }
  }
  function writeCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ v: value, t: Date.now() })); }
    catch (e) { log('cache write failed (probably quota):', e.message); }
  }

  // === GM_xmlhttpRequest promisified (bypasses CORS + uses user's home IP) ===
  function gmFetchJSON(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('Bad JSON: ' + e.message)); }
          } else {
            const err = new Error('HTTP ' + r.status);
            err.status = r.status;
            reject(err);
          }
        },
        onerror: () => reject(new Error('Network error: ' + url)),
        ontimeout: () => reject(new Error('Timeout: ' + url)),
      });
    });
  }

  // === Skinport prices ===
  let priceMap = null;
  let priceMapLoading = null;
  async function getPriceMap() {
    if (priceMap) return priceMap;
    if (priceMapLoading) return priceMapLoading;
    const cached = readCache(PRICE_CACHE_KEY, PRICE_TTL_MS);
    if (cached) {
      priceMap = new Map(cached);
      log('Loaded ' + priceMap.size + ' prices from cache');
      return priceMap;
    }
    priceMapLoading = (async () => {
      log('Fetching prices from Skinport…');
      const t0 = Date.now();
      const arr = await gmFetchJSON('https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0');
      const m = new Map();
      for (const item of arr) {
        const price = item.suggested_price ?? item.mean_price ?? item.min_price;
        if (item.market_hash_name && typeof price === 'number') {
          m.set(item.market_hash_name, price);
        }
      }
      writeCache(PRICE_CACHE_KEY, [...m]);
      priceMap = m;
      priceMapLoading = null;
      log('Loaded ' + m.size + ' prices from Skinport in ' + (Date.now() - t0) + 'ms');
      return m;
    })().catch((e) => {
      priceMapLoading = null;
      throw e;
    });
    return priceMapLoading;
  }

  // === Steam inventory fetch ===
  async function fetchSteamInventory(steamid64) {
    const cacheKey = INV_CACHE_PREFIX + steamid64;
    const cached = readCache(cacheKey, INV_TTL_MS);
    if (cached) return cached;

    const url = 'https://steamcommunity.com/inventory/' + steamid64 + '/730/2?l=english&count=5000';
    let json;
    try {
      json = await gmFetchJSON(url);
    } catch (e) {
      log('[steam ' + steamid64 + '] http error', e.status || '?', e.message);
      if (e.status === 401 || e.status === 403) {
        const r = { is_private: true };
        writeCache(cacheKey, r);
        return r;
      }
      if (e.status === 429) return { error: 'rate_limited' };
      return { error: e.message };
    }

    if (!json || json.success === false) {
      log('[steam ' + steamid64 + '] success=false → private');
      const r = { is_private: true };
      writeCache(cacheKey, r);
      return r;
    }
    if (!Array.isArray(json.descriptions)) {
      log('[steam ' + steamid64 + '] no descriptions array — empty inventory');
      const r = { is_private: false, items: [] };
      writeCache(cacheKey, r);
      return r;
    }

    const descByKey = new Map();
    for (const d of json.descriptions) {
      if (d?.market_hash_name) {
        descByKey.set(d.classid + '_' + d.instanceid, d.market_hash_name);
      }
    }
    const items = [];
    for (const a of json.assets || []) {
      const name = descByKey.get(a.classid + '_' + a.instanceid);
      if (name) items.push(name);
    }
    const result = { is_private: false, items };
    log('[steam ' + steamid64 + '] OK — ' + items.length + ' items');
    writeCache(cacheKey, result);
    return result;
  }

  // === Sum item prices ===
  function sumItems(items, prices) {
    let total = 0, counted = 0, missing = 0;
    for (const name of items) {
      const p = prices.get(name);
      if (typeof p === 'number') { total += p; counted++; }
      else missing++;
    }
    return { total_usd: Math.round(total * 100) / 100, counted, missing };
  }

  // === Concurrency-limited parallel ===
  async function withConcurrency(items, n, fn) {
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const i = idx++;
        try { await fn(items[i], i); } catch (e) { log('worker error', e); }
      }
    }
    await Promise.all(Array.from({ length: n }, worker));
  }

  // === Inject CSS ===
  const style = document.createElement('style');
  style.textContent = `
    .csli-badge {
      display: inline-block; padding: 1px 6px; margin-left: 6px;
      background: rgba(255,87,34,0.15); color: #ff7043;
      border-radius: 4px; font-size: 11px; font-weight: 600;
      font-variant-numeric: tabular-nums; vertical-align: middle;
    }
    .csli-badge.private { background: rgba(120,120,120,0.15); color: #888; font-weight: 400; }
    .csli-badge.loading { background: rgba(120,120,120,0.15); color: #888; font-weight: 400; }
    .csli-badge.error { background: rgba(248,113,113,0.15); color: #f87171; }
    .csli-total-panel {
      position: fixed; bottom: 20px; right: 20px; z-index: 99999;
      background: #15181d; border: 1px solid #ff5722; border-radius: 8px;
      padding: 12px 16px; color: #e6e9ee;
      font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5); min-width: 220px;
    }
    .csli-total-panel .csli-label {
      font-size: 11px; color: #8a93a0;
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px;
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

  // === Panel ===
  let panel = null;
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

  // === Fetch player list from Cybershoke ===
  async function fetchCybershokePlayers(ip, port) {
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

  // === Badge inject ===
  function injectBadge(modal, nick) {
    for (const td of modal.querySelectorAll('td')) {
      if ((td.textContent || '').trim() === nick) {
        let b = td.querySelector('.csli-badge');
        if (b) return b;
        b = document.createElement('span');
        b.className = 'csli-badge loading';
        b.textContent = '…';
        td.appendChild(b);
        return b;
      }
    }
    return null;
  }

  // === State ===
  let currentServerKey = null;
  let totalUsd = 0;
  let done = 0, plannedTotal = 0;

  // === Main per-server handler ===
  async function handleServerOpen(modal, ip, port) {
    const key = ip + ':' + port;
    if (currentServerKey === key) return;
    currentServerKey = key;
    log('Server opened:', key);

    showPanel();
    totalUsd = 0; done = 0; plannedTotal = 0;
    updatePanel({ total: 0, progress: 'Загрузка игроков и цен…' });

    // Kick off prices fetch in parallel with player fetch
    const pricesP = getPriceMap().catch(e => { log('prices error', e); return new Map(); });

    let players;
    try {
      players = await fetchCybershokePlayers(ip, port);
    } catch (e) {
      log('cybershoke error', e);
      updatePanel({ progress: 'Cybershoke: ' + e.message });
      return;
    }

    const withIds = players.filter(p => p.steamid64);
    log(withIds.length + '/' + players.length + ' players have steamid64');
    if (withIds.length === 0) {
      updatePanel({ progress: 'У игроков нет SteamID. Залогиньтесь на Cybershoke.' });
      return;
    }

    // Initialize badges
    const badges = new Map();
    for (const p of withIds) {
      const b = injectBadge(modal, p.name);
      if (b) badges.set(p.steamid64, b);
    }

    // Wait for prices
    const prices = await pricesP;
    log('Prices ready: ' + prices.size + ' items');

    plannedTotal = withIds.length;
    updatePanel({ progress: '0/' + plannedTotal + ' инвентарей загружено' });

    // Stats counters
    let priced = 0, priv = 0, errs = 0;

    await withConcurrency(withIds, STEAM_CONCURRENCY, async (p) => {
      if (currentServerKey !== key) return; // user switched servers
      const b = badges.get(p.steamid64);
      const inv = await fetchSteamInventory(p.steamid64);
      if (currentServerKey !== key) return;
      if (inv.is_private) {
        if (b) { b.className = 'csli-badge private'; b.textContent = '🔒'; }
        priv++;
      } else if (inv.error) {
        if (b) { b.className = 'csli-badge error'; b.textContent = '!'; b.title = inv.error; }
        errs++;
      } else {
        const { total_usd } = sumItems(inv.items, prices);
        if (b) { b.className = 'csli-badge'; b.textContent = '$' + total_usd.toFixed(0); }
        totalUsd += total_usd;
        priced++;
      }
      done++;
      updatePanel({
        total: totalUsd,
        progress: done + '/' + plannedTotal + ' · ' + priced + ' 💰 · ' + priv + ' 🔒 · ' + errs + ' !',
      });
    });

    log('Done. Total $' + totalUsd.toFixed(2));
  }

  // === Detect server modal via DOM ===
  function extractIpPort(modal) {
    const m = (modal.innerText || '').match(/IP\s+(\d{1,3}(?:\.\d{1,3}){3})[:\s]+(\d{1,5})/);
    return m ? { ip: m[1], port: m[2] } : null;
  }
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
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const ipPort = extractIpPort(modal);
      if (!ipPort) return;
      handleServerOpen(modal, ipPort.ip, ipPort.port);
    }, 600);
  }
  const observer = new MutationObserver(checkForModal);
  observer.observe(document.body, { childList: true, subtree: true });
  checkForModal();

  log('Cybershoke Inventory Live v0.3.1 ready.');
  log('Commands: csliClearCache() · csliSetBackend(url) (backend deprecated in v0.3.x)');
})();

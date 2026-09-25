/* bybit-live.js — the app's live line to your Bybit account, through the relay.

   The browser never holds the API secret. You paste a read-only key pair
   once, into the app; the app hands it to the relay on localhost; the relay
   verifies it with Bybit, keeps it in verdicts/.bybit-key.json (git-ignored,
   this machine only), and from then on signs every private request itself.
   The app only ever sees the key's last four characters, the positions, and
   the closed trades.

   Two things are read and nothing else: open positions (/v5/position/list)
   and closed P&L (/v5/position/closed-pnl). No order is ever placed,
   cancelled or altered — and the key you make should not be able to either:
   Bybit's API Management page lets you create a key as read-only, and the
   relay checks that flag when you connect and warns if it is not set.

   Split like bybit.js: the pure pieces (mapping a position row, masking a
   key, deciding whether a verify result is read-only) sit up top with no
   network; the fetching and the key file below.
   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');
const { bybitHeaders, bybitMapClosedTrades } = require('./bybit.js');

const API = 'https://api.bybit.com';
const DAY = 86400e3;
const WINDOW = 7 * DAY;           // per-request chunk for closed P&L — see bybit-import.js
const PAGE = 100;
const KEY_FILE = '.bybit-key.json';

/* ==BYBIT_LIVE_START== */
function bybitMaskKey(key) {
  const k = String(key || '');
  if (k.length <= 4) return k ? '••••' : '';
  return '••••' + k.slice(-4);
}

/*  One open position from /v5/position/list → what the app shows. A row
    with no size is a closed slot Bybit still lists; it is dropped.       */
function bybitMapPosition(row, symbolOf) {
  if (!row || !row.symbol) return null;
  const size = +row.size;
  if (!(size > 0)) return null;
  const entry = +row.avgPrice, mark = +row.markPrice;
  const side = row.side === 'Sell' ? 'short' : 'long';
  const sym = symbolOf ? symbolOf(row.symbol) : String(row.symbol).replace(/USDT$/, '');
  const unreal = +row.unrealisedPnl;
  const value = +row.positionValue;
  const pct = isFinite(entry) && entry > 0 && isFinite(mark)
    ? (side === 'long' ? mark - entry : entry - mark) / entry * 100 : null;
  const lev = +row.leverage;
  return {
    symbol: sym, pair: row.symbol, side, size,
    entry: isFinite(entry) ? entry : null,
    mark: isFinite(mark) ? mark : null,
    liq: +row.liqPrice > 0 ? +row.liqPrice : null,
    leverage: isFinite(lev) ? lev : null,
    value: isFinite(value) ? value : null,
    unrealised: isFinite(unreal) ? unreal : null,
    unrealisedPct: pct == null ? null : +pct.toFixed(2),
    // margin at risk, so a position can be read in R-ish terms without a stop
    marginPct: isFinite(lev) && lev > 0 && pct != null ? +(pct * lev).toFixed(1) : null,
    takeProfit: +row.takeProfit > 0 ? +row.takeProfit : null,
    stopLoss: +row.stopLoss > 0 ? +row.stopLoss : null,
    openedAt: +row.createdTime || null,
    updatedAt: +row.updatedTime || null,
  };
}

function bybitMapPositions(rows, symbolOf) {
  return (rows || []).map(r => bybitMapPosition(r, symbolOf)).filter(Boolean)
    .sort((a, b) => (b.value || 0) - (a.value || 0));
}

/*  What /v5/user/query-api says about a key: read-only or not, and what it
    can reach. Pure over the result object.                              */
function bybitKeyProfile(result) {
  const r = result || {};
  const perms = r.permissions && typeof r.permissions === 'object' ? r.permissions : {};
  const grants = Object.keys(perms).reduce((n, k) => n + (Array.isArray(perms[k]) ? perms[k].length : 0), 0);
  return {
    readOnly: r.readOnly === 1 || r.readOnly === true,
    note: r.note || null,
    expiresAt: r.expiredAt && r.expiredAt !== '-1' && r.expiredAt !== -1 ? r.expiredAt : null,
    permissions: perms,
    grants,
    unified: r.unified === 1 || r.uta === 1,
  };
}
/* ==BYBIT_LIVE_END== */

/* ---------- the key file ---------- */

function bybitKeyPath(dir) { return path.join(dir || path.join(__dirname, '..', 'verdicts'), KEY_FILE); }

/*  The pair, from the file the app saved or from the environment the import
    script already uses. Never thrown: no key is "not connected".         */
function bybitLoadKey(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(bybitKeyPath(dir), 'utf8'));
    if (j && j.key && j.secret) return { key: String(j.key), secret: String(j.secret), source: 'file', savedAt: j.savedAt || null, readOnly: j.readOnly == null ? null : !!j.readOnly };
  } catch (e) { /* no file */ }
  const key = process.env.ODYSSEUS_BYBIT_KEY, secret = process.env.ODYSSEUS_BYBIT_SECRET;
  if (key && secret) return { key: String(key), secret: String(secret), source: 'env', savedAt: null, readOnly: null };
  return null;
}

function bybitSaveKey(dir, key, secret, profile) {
  const file = bybitKeyPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = { key: String(key), secret: String(secret), savedAt: new Date().toISOString(),
                 readOnly: profile ? !!profile.readOnly : null };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  return body;
}

function bybitForgetKey(dir) {
  try { fs.unlinkSync(bybitKeyPath(dir)); return true; } catch (e) { return false; }
}

/* ---------- signed requests ---------- */

/*  Tests point this at a fake exchange; nothing else ever sets it.        */
let fetchOverride = null;
function bybitSetFetch(fn) { fetchOverride = fn || null; }

async function bybitPrivateGet(key, secret, endpoint, params, fetchImpl) {
  const f = fetchImpl || fetchOverride || fetch;
  const qs = new URLSearchParams(params || {}).toString();
  const headers = Object.assign({ 'content-type': 'application/json' }, bybitHeaders(key, secret, qs));
  const res = await f(API + endpoint + (qs ? '?' + qs : ''), { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from Bybit: ' + (body.retMsg || res.statusText));
  if (body.retCode !== 0) throw new Error('Bybit rejected the request: ' + (body.retMsg || body.retCode) +
    (body.retCode === 10003 || body.retCode === 10004 ? ' (check the key and secret, and that the key is enabled for this account)' : ''));
  return body.result;
}

/*  Is this pair real, and is it read-only. Bybit's own description of the
    key, which costs nothing and touches no balance.                      */
async function bybitVerify(key, secret, fetchImpl) {
  const result = await bybitPrivateGet(key, secret, '/v5/user/query-api', {}, fetchImpl);
  return bybitKeyProfile(result);
}

async function bybitPositions(key, secret, symbolOf, fetchImpl) {
  const rows = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const params = { category: 'linear', settleCoin: 'USDT', limit: '200' };
    if (cursor) params.cursor = cursor;
    const result = await bybitPrivateGet(key, secret, '/v5/position/list', params, fetchImpl);
    rows.push(...(result.list || []));
    cursor = result.nextPageCursor || '';
    if (!cursor) break;
  }
  return bybitMapPositions(rows, symbolOf);
}

/*  Closed P&L over the last `days`, walked backward in week-sized chunks and
    paged inside each — the same walk mcp/bybit-import.js does.           */
async function bybitClosedRows(key, secret, days, fetchImpl) {
  const end = Date.now();
  const start = end - Math.max(1, Math.min(days || 7, 730)) * DAY;
  const rows = [];
  for (let winEnd = end; winEnd > start; winEnd -= WINDOW) {
    const winStart = Math.max(start, winEnd - WINDOW);
    let cursor = '';
    for (;;) {
      const params = { category: 'linear', startTime: String(winStart), endTime: String(winEnd), limit: String(PAGE) };
      if (cursor) params.cursor = cursor;
      const result = await bybitPrivateGet(key, secret, '/v5/position/closed-pnl', params, fetchImpl);
      const list = result.list || [];
      rows.push(...list);
      cursor = result.nextPageCursor || '';
      if (!cursor || !list.length) break;
    }
  }
  return rows;
}

async function bybitClosedTrades(key, secret, days, symbolOf, fetchImpl) {
  return bybitMapClosedTrades(await bybitClosedRows(key, secret, days, fetchImpl), symbolOf);
}

module.exports = {
  bybitMaskKey, bybitMapPosition, bybitMapPositions, bybitKeyProfile,
  bybitKeyPath, bybitLoadKey, bybitSaveKey, bybitForgetKey,
  bybitPrivateGet, bybitVerify, bybitPositions, bybitClosedRows, bybitClosedTrades, bybitSetFetch,
  KEY_FILE, API,
};

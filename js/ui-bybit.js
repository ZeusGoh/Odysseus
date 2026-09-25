/* ui-bybit.js — the live line to your Bybit account, on the Journal page.

   Two things come in, both read-only: the positions you are in right now,
   and the trades you have closed, which land in the journal by themselves.
   The app never holds the API secret. You paste a read-only key pair once,
   here; it goes to the relay on this machine over localhost, the relay
   verifies it with Bybit and keeps it on disk, and from then on the relay
   signs every request. What comes back to the browser is the key's last
   four characters, the positions, and the trades.

   Closed trades arrive through jImportTrades, the same door the file import
   uses, so a trade is never logged twice (sourceId) and never rewritten
   once it is in. The relay is polled on a slow clock whatever view is
   showing, so the journal fills itself while you are looking elsewhere;
   the positions refresh only while the Journal is open.
   part of Odysseus */

const BYBIT_POS_EVERY_MS = 15e3;          // positions, while the Journal is showing
const BYBIT_SYNC_EVERY_MS = 5 * 60e3;     // closed trades, whatever is showing
const BYBIT_SYNC_DAYS = 3;                // the window each automatic sync asks for
const BYBIT_FIRST_SYNC_DAYS = 90;         // the first sync after connecting reaches back further

const bybitState = {
  status: null, statusAt: 0, err: '',
  positions: null, posAt: 0, posErr: '', posLoading: false,
  syncing: false, lastSync: null, syncNote: '',
  connecting: false, note: '',
  posTimer: null, syncTimer: null, sig: '',
};

/* ---------- relay calls (the analyst relay's own client, same origin rules) ---------- */

async function bybitCall(pathname, body) {
  return analystRelayCall(pathname, body);
}

async function bybitStatusRefresh(force) {
  if (!force && bybitState.status && Date.now() - bybitState.statusAt < 20e3) return bybitState.status;
  try {
    bybitState.status = await bybitCall('/bybit/status');
    bybitState.err = '';
  } catch (e) {
    bybitState.status = null;
    bybitState.err = e.message;
  }
  bybitState.statusAt = Date.now();
  return bybitState.status;
}

/*  Connect: the pair leaves this page exactly once, to the relay. The
    fields are cleared whether it worked or not — a wrong pair is not
    something to keep on screen either.                                  */
async function bybitConnect() {
  const keyEl = $('by-key'), secEl = $('by-secret');
  const key = (keyEl.value || '').trim(), secret = (secEl.value || '').trim();
  if (!key || !secret) { bybitState.note = 'Paste both the API key and the secret.'; renderBybit(); return; }
  bybitState.connecting = true; bybitState.note = 'Checking the key with Bybit…'; renderBybit();
  try {
    const st = await bybitCall('/bybit/key', { key, secret });
    bybitState.status = st; bybitState.statusAt = Date.now(); bybitState.err = '';
    bybitState.note = st.readOnly === false
      ? 'Connected — but this key is NOT read-only. Odysseus only ever reads, but a key that can trade is a key that can be misused if it leaks. Make a read-only one in Bybit and paste that instead.'
      : 'Connected. Pulling your last ' + BYBIT_FIRST_SYNC_DAYS + ' days of closed trades…';
    keyEl.value = ''; secEl.value = '';
    bybitState.positions = null; bybitState.posAt = 0;
    renderBybit();
    await bybitSyncTrades(BYBIT_FIRST_SYNC_DAYS, true);
    if (st.readOnly !== false) bybitState.note = '';        // the sync line says the rest
    bybitPositionsRefresh(true);
  } catch (e) {
    bybitState.note = 'Could not connect: ' + e.message;
  } finally {
    keyEl.value = ''; secEl.value = '';
    bybitState.connecting = false;
    renderBybit();
  }
}

async function bybitForget() {
  try {
    bybitState.status = await bybitCall('/bybit/forget', {});
    bybitState.statusAt = Date.now();
    bybitState.positions = null; bybitState.note = 'Disconnected. The key file on this machine was deleted; trades already in the journal stay.';
  } catch (e) { bybitState.note = 'Could not disconnect: ' + e.message; }
  renderBybit();
}

/* ---------- closed trades → journal ---------- */

async function bybitSyncTrades(days, loud) {
  if (bybitState.syncing) return null;
  const st = await bybitStatusRefresh();
  if (!st || !st.configured) { if (loud) { bybitState.syncNote = st ? 'Bybit is not connected.' : 'The relay is not running.'; renderBybit(); } return null; }
  bybitState.syncing = true;
  if (loud) { bybitState.syncNote = 'Syncing…'; renderBybit(); }
  try {
    const r = await bybitCall('/bybit/trades?days=' + (days || BYBIT_SYNC_DAYS));
    const res = jImportTrades(r.trades || []);
    bybitState.lastSync = { at: Date.now(), added: res.added, skipped: res.skipped, days: r.days, fetched: (r.trades || []).length };
    bybitState.syncNote = res.added
      ? 'Synced: ' + res.added + ' new trade' + (res.added === 1 ? '' : 's') + ' from the last ' + r.days + ' days' + (res.skipped ? ' (' + res.skipped + ' already logged)' : '') + '.'
      : 'Up to date — ' + (r.trades || []).length + ' closed trade' + ((r.trades || []).length === 1 ? '' : 's') + ' in the last ' + r.days + ' days, all already in the journal.';
    if (res.added && typeof renderJournal === 'function') renderJournal();
    return res;
  } catch (e) {
    bybitState.syncNote = 'Sync failed: ' + e.message;
    return null;
  } finally {
    bybitState.syncing = false;
    renderBybit();
  }
}

/* ---------- open positions ---------- */

async function bybitPositionsRefresh(force) {
  if (bybitState.posLoading) return;
  if (!force && bybitState.positions && Date.now() - bybitState.posAt < BYBIT_POS_EVERY_MS) return;
  const st = await bybitStatusRefresh();
  if (!st || !st.configured) { renderBybit(); return; }
  bybitState.posLoading = true;
  try {
    const r = await bybitCall('/bybit/positions');
    bybitState.positions = r.positions || [];
    bybitState.posAt = Date.now(); bybitState.posErr = '';
  } catch (e) {
    bybitState.posErr = e.message;
  } finally {
    bybitState.posLoading = false;
    renderBybit();
  }
}

/* ---------- the view ---------- */

function bybitMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1000 ? a.toLocaleString(undefined, { maximumFractionDigits: 0 }) : a.toFixed(2);
  return (v < 0 ? '−$' : '$') + s;
}

/*  What the app itself says about a coin you are in: the stochastic
    composite if that coin's frames are loaded, and the analysts' latest
    call if there is a report — so a position and the desk's opinion of
    it sit on one line.                                                  */
function bybitReadFor(sym) {
  const st = states[sym];
  const score = st ? bias(st, WEIGHTS) : null;
  const stoch = score == null ? null : { score, lean: score > 8 ? 'long' : score < -8 ? 'short' : 'mixed' };
  const rep = typeof analystLatestFor === 'function' ? analystLatestFor(analystReports, sym) : null;
  return { stoch, report: rep };
}

function renderBybit() {
  const strip = $('by-strip');
  if (!strip) return;
  const st = bybitState.status;
  const online = !!st;
  const configured = !!(st && st.configured);

  // the strip: what is connected, and how it is doing
  let html = '';
  if (!online) html += analystChip('relay offline', 'off') + '<span class="anhint">The Bybit line runs through the relay — start it with <code>launch\\11 - Relay always on</code>. ' + nvEsc(bybitState.err || '') + '</span>';
  else if (!configured) html += analystChip('not connected', 'warn') + '<span class="anhint">Paste a read-only API key below. Nothing here can trade.</span>';
  else html += analystChip('connected · key ' + st.key, st.readOnly === false ? 'warn' : 'on') +
    (st.readOnly === false ? analystChip('key can trade — make a read-only one', 'off') : st.readOnly === true ? analystChip('read-only', 'on') : '') +
    (st.source === 'env' ? analystChip('from environment variables', '') : '') +
    (bybitState.lastSync ? analystChip('synced ' + analystAgeLabel({ at: bybitState.lastSync.at }, Date.now()), '') : '') +
    (st.lastError ? analystChip('last error: ' + st.lastError, 'off') : '');
  strip.innerHTML = html;

  const form = $('by-form'), conn = $('by-connected');
  if (form) form.hidden = !online || configured;
  if (conn) conn.hidden = !configured;
  const cb = $('by-connect'); if (cb) cb.disabled = !online || bybitState.connecting;
  const sb = $('by-sync'); if (sb) sb.disabled = !configured || bybitState.syncing;
  const note = $('by-note'); if (note) note.textContent = bybitState.note || '';
  const sn = $('by-syncnote'); if (sn) sn.textContent = bybitState.syncNote || '';

  // the positions
  const host = $('by-positions');
  const sub = $('by-pos-sub');
  if (!configured) {
    host.innerHTML = '<div class="loading">' + (online ? 'Connect Bybit to see what you are in.' : 'The relay is offline.') + '</div>';
    if (sub) sub.textContent = 'what you are in on Bybit right now';
    return;
  }
  const pos = bybitState.positions;
  if (bybitState.posErr && !pos) { host.innerHTML = '<div class="loading">Could not load positions: ' + nvEsc(bybitState.posErr) + '</div>'; return; }
  if (!pos) { host.innerHTML = '<div class="loading">Loading positions…</div>'; return; }
  if (!pos.length) {
    host.innerHTML = '<div class="loading">Flat — no open positions on Bybit.</div>';
    if (sub) sub.textContent = 'flat · checked ' + new Date(bybitState.posAt).toLocaleTimeString();
    return;
  }
  const totalU = pos.reduce((a, p) => a + (p.unrealised || 0), 0);
  if (sub) sub.textContent = pos.length + ' open · unrealised ' + bybitMoney(totalU) + ' · checked ' + new Date(bybitState.posAt).toLocaleTimeString();
  host.innerHTML = pos.map(p => {
    const rd = bybitReadFor(p.symbol);
    const uTone = p.unrealised == null ? '' : p.unrealised >= 0 ? 'up' : 'down';
    const stochCell = rd.stoch
      ? '<span class="anpill ' + (rd.stoch.lean === 'long' ? 'up' : rd.stoch.lean === 'short' ? 'down' : 'flat') + '" title="stochastic composite ' + rd.stoch.score + '">' + rd.stoch.lean + ' ' + (rd.stoch.score > 0 ? '+' : '') + rd.stoch.score + '</span>'
      : '<span class="none" title="open this coin in the Terminal to load its frames">·</span>';
    const r = rd.report;
    const anCell = r
      ? '<span class="anpill ' + (r.direction === 'bull' ? 'up' : r.direction === 'bear' ? 'down' : r.direction === 'split' ? 'clash' : 'flat') + '" title="' + nvEsc(r.headline) + '">' + nvEsc(r.direction || 'split') + '</span>' +
        '<em class="byage">' + nvEsc(analystAgeLabel(r, Date.now())) + '</em>'
      : '<span class="none">no read</span>';
    // with or against: the desk's direction against the side you are on
    const against = r && (r.direction === 'bull' || r.direction === 'bear') ? ((r.direction === 'bull') !== (p.side === 'long')) : null;
    return '<div class="mrow byrow' + (against === true ? ' against' : '') + '">' +
      '<div class="jsym">' + nvIcon(p.symbol) + '<b>' + nvEsc(p.symbol) + '</b>' + (p.leverage ? '<em>' + p.leverage + '×</em>' : '') + '</div>' +
      '<div><span class="anpill ' + (p.side === 'long' ? 'up' : 'down') + '">' + p.side + '</span></div>' +
      '<div class="num">' + nvEsc(String(p.size)) + '<em class="bysub">' + bybitMoney(p.value) + '</em></div>' +
      '<div class="num">' + (p.entry != null ? fmtUsd(p.entry) : '—') + '</div>' +
      '<div class="num">' + (p.mark != null ? fmtUsd(p.mark) : '—') + '</div>' +
      '<div class="num ' + uTone + '">' + bybitMoney(p.unrealised) + '<em class="bysub">' + (p.unrealisedPct == null ? '' : (p.unrealisedPct > 0 ? '+' : '') + p.unrealisedPct + '%') + (p.marginPct != null ? ' · ' + (p.marginPct > 0 ? '+' : '') + p.marginPct + '% on margin' : '') + '</em></div>' +
      '<div class="num">' + (p.stopLoss != null ? fmtUsd(p.stopLoss) : '<span class="none">none</span>') + (p.takeProfit != null ? '<em class="bysub">tp ' + fmtUsd(p.takeProfit) + '</em>' : '') + '</div>' +
      '<div class="num ' + (p.liq != null ? 'dim' : '') + '">' + (p.liq != null ? fmtUsd(p.liq) : '—') + '</div>' +
      '<div>' + stochCell + '</div>' +
      '<div class="byan">' + anCell + (against === true ? '<em class="byagainst">against you</em>' : '') + '</div>' +
      '<div class="byact"><button class="ghost" data-by-log="' + nvEsc(p.symbol) + '" title="Open the log form with this position filled in">Log</button>' +
      '<button class="ghost" data-by-open="' + nvEsc(p.symbol) + '" title="Open this coin in the Terminal">Open</button></div>' +
      '</div>';
  }).join('');
  host.querySelectorAll('[data-by-open]').forEach(b => { b.onclick = () => { switchSymbol(b.getAttribute('data-by-open')); setView('terminal'); }; });
  host.querySelectorAll('[data-by-log]').forEach(b => {
    b.onclick = () => {
      const p = pos.find(x => x.symbol === b.getAttribute('data-by-log'));
      if (!p) return;
      jOpenForm({ symbol: p.symbol, direction: p.side, entryPrice: p.entry, invalidation: p.stopLoss, size: p.size, entryTime: p.openedAt || undefined });
    };
  });
}

/* ---------- wiring ---------- */

function bybitShow() {
  bybitStatusRefresh(true).then(() => { renderBybit(); bybitPositionsRefresh(true); });
  if (!bybitState.posTimer) bybitState.posTimer = setInterval(() => { if (view === 'journal') bybitPositionsRefresh(); }, BYBIT_POS_EVERY_MS);
}

function buildBybitControls() {
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('by-connect', bybitConnect);
  on('by-forget', bybitForget);
  on('by-sync', () => bybitSyncTrades(BYBIT_SYNC_DAYS * 10, true));
  const sec = $('by-secret');
  if (sec) sec.onkeydown = e => { if (e.key === 'Enter') bybitConnect(); };
  // the slow clock: the journal fills itself while you are elsewhere
  if (!bybitState.syncTimer) {
    bybitState.syncTimer = setInterval(() => bybitSyncTrades(BYBIT_SYNC_DAYS, false), BYBIT_SYNC_EVERY_MS);
    setTimeout(() => bybitSyncTrades(BYBIT_SYNC_DAYS, false), 8000);
  }
}

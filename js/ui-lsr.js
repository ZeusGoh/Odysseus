/* ui-lsr.js — the long/short ratio panel on the Terminal: taker buy against
   taker sell volume on the active coin's perpetual, exchange by exchange,
   over the last hour, four hours or day, and the sum.

   Binance, Bitget and Gate publish hourly buckets a browser can fetch with
   no key. Bybit and OKX publish only the tape, so the panel opens a public
   trade stream to each the moment it is first shown and sums the trades
   into the same buckets; their rows say how much of the window the stream
   has seen, and they join the total once it is all of it. Nothing here
   goes through the relay and no key is involved.

   Follows the symbol bar like the rest of the Terminal: the buckets are
   refetched when the coin changes and on a slow clock, the streams are
   re-pointed at the new coin (and its tape starts over). Every feed is
   optional — an exchange that does not list the coin, or is down, is a
   gap on its row, not a reason to show nothing.
   part of Odysseus */

const LSR_EVERY_MS = 60e3;
const LSR_TAPE_REDRAW_MS = 5e3;
const lsrState = { sym: null, feeds: {}, tapes: {}, price: null, at: 0, err: null, loading: false, notes: [],
                   window: '4h', timer: null, redraw: null, sockets: {}, ctVal: {} };

/* ---------- the hourly buckets ---------- */

async function lsrJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const lsrSoft = (p, what) => p.then(v => ({ v })).catch(e => ({ missing: what + ': ' + (e.message || 'unavailable') }));

async function lsrFetch(sym) {
  const meta = symbolOf(sym);
  const base = String(sym).toUpperCase().replace(/USDT$/, '');
  const pair = base + 'USDT';
  const limit = LSR_KEEP_H + 2;
  const [bn, bn5, bg, gt, gc, by] = await Promise.all([
    lsrSoft(lsrJson('https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=' + pair + '&period=1h&limit=' + limit), 'Binance'),
    lsrSoft(lsrJson('https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=' + pair + '&period=5m&limit=14'), 'Binance (this hour)'),
    lsrSoft(lsrJson('https://api.bitget.com/api/v2/mix/market/taker-buy-sell?symbol=' + pair + '&period=1h'), 'Bitget'),
    lsrSoft(lsrJson('https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=' + base + '_USDT&interval=1h&limit=' + Math.min(limit, 100)), 'Gate'),
    lsrSoft(lsrJson('https://api.gateio.ws/api/v4/futures/usdt/contracts/' + base + '_USDT'), 'Gate contract'),
    lsrSoft(bybit('/tickers?category=linear&symbol=' + (meta.bybit || pair)), 'Bybit price'),
  ]);
  const notes = [bn, bn5, bg, gt, gc, by].map(x => x.missing).filter(Boolean);
  const ticker = by.v && by.v.list && by.v.list[0];
  return {
    sym: base,
    feeds: {
      binance: lsrFromBinanceTaker(Array.isArray(bn.v) ? bn.v : null, Array.isArray(bn5.v) ? bn5.v : null),
      bitget: lsrFromBitgetTaker(bg.v && bg.v.data ? bg.v.data : null),
      gate: lsrFromGateTaker(Array.isArray(gt.v) ? gt.v : null, gc.v ? gc.v.quanto_multiplier : null),
    },
    price: ticker && isFinite(+ticker.lastPrice) ? +ticker.lastPrice : null,
    notes, at: Date.now(),
  };
}

/* ---------- the tapes ---------- */

/*  One public trade stream per exchange that has nothing else. Reconnects
    while the page lives; a socket that drops keeps its tape, since the
    buckets it already filled are real, but its coverage is measured from
    when it was last connected without a gap.                             */
function lsrSocketOpen(key, sym) {
  const base = String(sym).toUpperCase().replace(/USDT$/, '');
  lsrSocketClose(key);
  const tape = lsrTapeNew(Date.now());
  lsrState.tapes[key] = tape;
  const slot = { ws: null, ping: null, closed: false, retry: 0 };
  lsrState.sockets[key] = slot;
  const connect = () => {
    if (slot.closed) return;
    let ws;
    try { ws = new WebSocket(key === 'bybit' ? 'wss://stream.bybit.com/v5/public/linear' : 'wss://ws.okx.com:8443/ws/v5/public'); }
    catch (e) { return; }
    slot.ws = ws;
    ws.onopen = () => {
      slot.retry = 0;
      if (tape.trades === 0 || tape.gap) { tape.since = Date.now(); tape.gap = false; }    // a reconnect after a gap starts the clock again
      if (key === 'bybit') ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.' + (symbolOf(base).bybit || base + 'USDT')] }));
      else ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: base + '-USDT-SWAP' }] }));
      slot.ping = setInterval(() => { try { ws.send(key === 'bybit' ? JSON.stringify({ op: 'ping' }) : 'ping'); } catch (e) {} }, 20e3);
    };
    ws.onmessage = m => {
      if (typeof m.data !== 'string' || m.data === 'pong') return;
      let d; try { d = JSON.parse(m.data); } catch (e) { return; }
      if (!d || !Array.isArray(d.data)) return;
      if (key === 'bybit') lsrTapeAdd(tape, d.data.map(x => ({ t: +x.T, side: x.S === 'Buy' ? 'buy' : x.S === 'Sell' ? 'sell' : null, size: +x.v })));
      else {
        const ct = lsrState.ctVal[base];
        if (!(ct > 0)) return;                        // contract size unknown yet: coins cannot be counted
        lsrTapeAdd(tape, d.data.map(x => ({ t: +x.ts, side: x.side, size: +x.sz * ct })));
      }
    };
    ws.onclose = () => {
      clearInterval(slot.ping); slot.ping = null; slot.ws = null;
      if (slot.closed) return;
      tape.gap = true;
      slot.retry++;
      setTimeout(connect, Math.min(60e3, 2e3 * Math.pow(2, slot.retry - 1)));
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  };
  if (key === 'okx' && !(lsrState.ctVal[base] > 0)) {
    lsrJson('https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=' + base + '-USDT-SWAP')
      .then(j => { const row = j && j.data && j.data[0]; if (row && +row.ctVal > 0) lsrState.ctVal[base] = +row.ctVal; })
      .catch(() => {})
      .finally(connect);
  } else connect();
}

function lsrSocketClose(key) {
  const slot = lsrState.sockets[key];
  if (!slot) return;
  slot.closed = true;
  clearInterval(slot.ping);
  try { if (slot.ws) slot.ws.close(); } catch (e) {}
  delete lsrState.sockets[key];
}

/* ---------- showing ---------- */

async function lsrShow(force) {
  const sym = active;
  if (!$('lsr-rows')) return;
  const changed = lsrState.sym !== sym;
  if (changed) {
    lsrState.sym = sym; lsrState.feeds = {}; lsrState.price = null; lsrState.at = 0; lsrState.err = null; lsrState.notes = [];
    if (typeof WebSocket !== 'undefined') { lsrSocketOpen('bybit', sym); lsrSocketOpen('okx', sym); }
    renderLsr();
  }
  if (!lsrState.timer) lsrState.timer = setInterval(() => { if (view === 'terminal') lsrShow(); }, LSR_EVERY_MS);
  if (!lsrState.redraw) lsrState.redraw = setInterval(() => { if (view === 'terminal' && lsrState.at) renderLsr(); }, LSR_TAPE_REDRAW_MS);
  if (!force && !changed && lsrState.at && Date.now() - lsrState.at < LSR_EVERY_MS) { renderLsr(); return; }
  if (lsrState.loading) return;
  lsrState.loading = true;
  try {
    const d = await lsrFetch(sym);
    if (lsrState.sym !== sym) return;
    lsrState.feeds = d.feeds; lsrState.price = d.price; lsrState.notes = d.notes; lsrState.at = d.at; lsrState.err = null;
  } catch (e) {
    if (lsrState.sym === sym) lsrState.err = e.message || 'unavailable';
  } finally {
    if (lsrState.sym === sym) lsrState.loading = false;
    renderLsr();
  }
}

function lsrSetWindow(key) {
  if (!LSR_WINDOWS.some(w => w.key === key)) return;
  lsrState.window = key;
  renderLsr();
}

/*  Everything the drawing needs, from the state: each exchange over the
    chosen window, the sum, the line and the read.                        */
function lsrCompute(now) {
  const win = LSR_WINDOWS.find(w => w.key === lsrState.window) || LSR_WINDOWS[1];
  const px = lsrState.price;
  const feeds = lsrState.feeds || {};
  const missing = key => (lsrState.notes || []).find(n => n.toLowerCase().startsWith(key)) || null;
  const exchanges = LSR_EXCHANGES.map(e => {
    if (e.how === 'tape') {
      const tape = lsrState.tapes[e.key];
      return lsrExchange(e.key, tape ? lsrTapeBuckets(tape, now) : [], px, win.hours, { now, since: tape && !tape.gap ? tape.since : null });
    }
    return lsrExchange(e.key, feeds[e.key] || [], px, win.hours, { now, missing: missing(e.key) });
  });
  const agg = lsrAggregate(exchanges);
  const series = lsrSeries([
    { buckets: feeds.binance || [] }, { buckets: feeds.bitget || [] }, { buckets: feeds.gate || [] },
    ...['bybit', 'okx'].map(k => { const t = lsrState.tapes[k]; return t && !t.gap ? { since: t.since, buckets: lsrTapeBuckets(t, now) } : null; }).filter(Boolean),
  ], now);
  const candles = typeof data !== 'undefined' && data[lsrState.sym] && data[lsrState.sym]['1H'];
  const priceChg = lsrPriceChange(candles, win.hours, now);
  return { win, agg, series, read: lsrRead(agg, priceChg), priceChg };
}

/* ---------- drawing ---------- */

function lsrUsd(v) { return v == null ? '—' : '$' + fmtVol(v); }
function lsrPctText(v, dp) { return v == null ? '—' : v.toFixed(dp == null ? 2 : dp) + '%'; }
function lsrBar(longPct, shortPct) {
  if (longPct == null) return '<div class="lsrbar empty"><span>no volume</span></div>';
  const l = Math.max(0, Math.min(100, longPct));
  return '<div class="lsrbar" role="img" aria-label="' + lsrPctText(longPct) + ' long, ' + lsrPctText(shortPct) + ' short">' +
    '<div class="lsrlong' + (l >= 50 ? ' lead' : '') + '" style="width:' + l.toFixed(2) + '%"><span>' + lsrPctText(longPct) + '</span></div>' +
    '<div class="lsrshort' + (l < 50 ? ' lead' : '') + '" style="width:' + (100 - l).toFixed(2) + '%"><span>' + lsrPctText(shortPct) + '</span></div></div>';
}
function lsrCoverText(e) {
  if (e.how !== 'tape') return '';
  if (e.coverage == null || e.since == null) return 'tape not connected';
  if (e.covered) return 'tape · whole window';
  const mins = Math.round((Date.now() - e.since) / 60000);
  if (mins < 1) return 'tape · just connected · not in the total yet';
  return 'tape · ' + (mins < 60 ? mins + ' min' : (mins / 60).toFixed(1) + ' h') + ' of ' + e.hours + 'h seen · not in the total yet';
}

/*  The aggregate buy share hour by hour over the last three days, the 50%
    line drawn so "who was pressing" reads at a glance. Inline SVG.       */
function lsrSpark(series, opts) {
  const o = opts || {};
  const W = 520, H = 64, P = 4;
  const pts = (series || []).slice(-LSR_KEEP_H);
  if (pts.length < 3) return '<div class="lsrnone">not enough hourly prints yet</div>';
  const vs = pts.map(p => p.v);
  let lo = Math.min(50, ...vs), hi = Math.max(50, ...vs);
  const pad = Math.max(1, (hi - lo) * 0.15); lo -= pad; hi += pad;
  const x = i => P + i / (pts.length - 1) * (W - 2 * P);
  const y = v => H - P - (v - lo) / (hi - lo) * (H - 2 * P);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  const col = o.tone === 'buy' ? 'var(--up)' : o.tone === 'sell' ? 'var(--down)' : 'var(--focus)';
  return '<svg class="lsrspark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="taker buy share, hourly, over the last ' + pts.length + ' hours">' +
    '<line x1="' + P + '" x2="' + (W - P) + '" y1="' + y(50).toFixed(1) + '" y2="' + y(50).toFixed(1) + '" class="lsrmid"/>' +
    '<path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="1.6" vector-effect="non-scaling-stroke"/>' +
    '<circle cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(last.v).toFixed(1) + '" r="2.5" fill="' + col + '"/>' +
    '</svg>' +
    '<div class="lsrsparklab"><span>' + new Date(pts[0].t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit' }) + '</span>' +
    '<span>hourly buy share · ' + Math.min(...vs).toFixed(1) + '–' + Math.max(...vs).toFixed(1) + '% · ' + pts.length + 'h</span><span>now</span></div>';
}

function renderLsr() {
  const total = $('lsr-total');
  if (!total) return;
  const sub = $('lsr-sub'), rows = $('lsr-rows'), rd = $('lsr-read'), sp = $('lsr-spark'), note = $('lsr-note'), winBox = $('lsr-win');
  if (winBox) winBox.querySelectorAll('[data-lsr-win]').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-lsr-win') === lsrState.window);
    if (!b.onclick) b.onclick = () => lsrSetWindow(b.getAttribute('data-lsr-win'));
  });
  if (!lsrState.at) {
    total.innerHTML = '<div class="loading">' + (lsrState.err ? 'Could not load the tape: ' + nvEsc(lsrState.err) : 'Reading taker volume on every exchange…') + '</div>';
    rows.innerHTML = ''; sp.innerHTML = ''; rd.textContent = '';
    if (sub) sub.textContent = 'taker buy against taker sell volume, exchange by exchange';
    return;
  }
  const now = Date.now();
  const { win, agg, series, read, priceChg } = lsrCompute(now);
  const sym = lsrState.sym;

  // the sum
  const tone = read.side || '';
  total.innerHTML = agg.longPct == null
    ? '<div class="lsrnone">no exchange has volume for this window yet</div>'
    : '<div class="lsrtot ' + tone + '">' +
      '<div class="lsrtotname"><b>' + nvEsc(sym) + '</b><em>' + agg.n + ' exchange' + (agg.n === 1 ? '' : 's') + ' · ' + win.key + '</em></div>' +
      lsrBar(agg.longPct, agg.shortPct) +
      '<div class="lsrusd"><span class="lab">Long</span><b class="up">' + lsrUsd(agg.buyUsd) + '</b></div>' +
      '<div class="lsrusd"><span class="lab">Short</span><b class="down">' + lsrUsd(agg.sellUsd) + '</b></div>' +
      '<div class="lsrratio"><span class="lab">L/S ratio</span><b>' + (agg.ratio == null ? '—' : agg.ratio.toFixed(2)) + '</b></div>' +
      '</div>';
  if (sub) sub.textContent = sym + ' perpetual · taker buy/sell volume · last ' + win.key + ' · refreshed ' + new Date(lsrState.at).toLocaleTimeString();

  // the read
  if (read.word) {
    rd.innerHTML = '<b class="' + (read.side === 'buy' ? 'up' : read.side === 'sell' ? 'down' : '') + '">' + read.word + '</b>' +
      ' · ' + lsrPctText(read.longPct, 1) + ' of aggressor volume buying' +
      (priceChg != null ? ' · price ' + (priceChg > 0 ? '+' : '') + priceChg.toFixed(2) + '% over the same ' + win.key : '') +
      (read.lean ? ' → <span class="lsrlean ' + read.lean + '">lean ' + (read.lean === 'bull' ? 'long' : 'short') + '</span>' : '') +
      '<span class="lsrwhy">' + nvEsc(read.why || '') + '</span>';
  } else rd.textContent = '';

  // the line
  sp.innerHTML = lsrSpark(series, { tone: read.side });

  // one row per exchange, the biggest book first
  rows.innerHTML = agg.exchanges.map(e =>
    '<div class="mrow lsrrow' + (e.how === 'tape' && !e.covered ? ' filling' : '') + '">' +
    '<div class="lsrex"><b>' + nvEsc(e.label) + '</b>' + (e.share != null ? '<em>' + e.share + '% of volume</em>' : e.missing ? '<em>' + nvEsc(e.missing) + '</em>' : '') + '</div>' +
    lsrBar(e.longPct, e.shortPct) +
    '<div class="lsrusd" data-lab="long"><b class="up">' + lsrUsd(e.buyUsd) + '</b></div>' +
    '<div class="lsrusd" data-lab="short"><b class="down">' + lsrUsd(e.sellUsd) + '</b></div>' +
    '<div class="lsrextra">' + (e.how === 'tape' ? nvEsc(lsrCoverText(e)) : e.buckets < win.hours && e.buyUsd != null ? e.buckets + ' of ' + win.hours + ' hours published' : '') + '</div>' +
    '</div>').join('');

  if (note) note.textContent = 'Long = volume where the aggressor bought (market buys, hitting the ask); Short = where the aggressor sold. ' +
    'Binance, Bitget and Gate publish hourly buckets; Bybit and OKX publish only the tape, so the app listens to their trade streams from the moment this panel first opens and counts them into the total once the stream covers the whole window — leave the app open and they fill in. ' +
    'Dollars are coins at the current price. "4h" is this hour plus the three before it.' +
    (lsrState.notes.length ? ' Not available this refresh: ' + lsrState.notes.join('; ') + '.' : '');
}

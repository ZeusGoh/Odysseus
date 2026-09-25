/* ui-oicvd.js — the open interest and CVD panel on the Terminal: price,
   open interest, perpetual CVD and spot CVD stacked on one time axis, over
   a day, three days, a week or a month, with a read of what they say
   together.

   All from Binance, in the browser, no key: spot klines and perpetual
   klines (each bar carries its taker-buy share, which is what a CVD is
   made of) and the perpetual's open-interest history. A coin Binance does
   not list on spot still gets its perp CVD and OI; the spot pane says so.

   Drawn as inline SVG, no library: four panes, each with its own scale,
   sharing x. Move the pointer across and the readout above the panes
   follows the bar under it. Follows the symbol bar; refetched on a slow
   clock while the Terminal is showing.
   part of Odysseus */

const OICVD_EVERY_MS = 60e3;
const ocState = { sym: null, window: '24h', data: null, at: 0, err: null, loading: false, timer: null, hover: null };

/* ---------- fetching ---------- */

async function ocJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const ocSoft = (p, what) => p.then(v => ({ v })).catch(e => ({ missing: what + ': ' + (e.message || 'unavailable') }));

async function ocFetch(sym, winKey) {
  const base = String(sym).toUpperCase().replace(/USDT$/, '');
  const pair = base + 'USDT';
  const win = OICVD_WINDOWS.find(w => w.key === winKey) || OICVD_WINDOWS[0];
  const [perp, spot, oi] = await Promise.all([
    ocSoft(ocJson('https://fapi.binance.com/fapi/v1/klines?symbol=' + pair + '&interval=' + win.interval + '&limit=' + win.bars), 'Binance perpetual'),
    ocSoft(ocJson('https://api.binance.com/api/v3/klines?symbol=' + pair + '&interval=' + win.interval + '&limit=' + win.bars), 'Binance spot'),
    ocSoft(ocJson('https://fapi.binance.com/futures/data/openInterestHist?symbol=' + pair + '&period=' + win.period + '&limit=' + Math.min(win.bars, 500)), 'Binance open interest'),
  ]);
  const notes = [perp, spot, oi].map(x => x.missing).filter(Boolean);
  const d = {
    sym: base, win,
    perp: cvdFromKlines(Array.isArray(perp.v) ? perp.v : null),
    spot: cvdFromKlines(Array.isArray(spot.v) ? spot.v : null),
    oi: oiFromHist(Array.isArray(oi.v) ? oi.v : null),
    notes, at: Date.now(),
  };
  // the same bars for everything: trim each series to the window's span
  const from = Math.max(d.perp.length ? d.perp[0].t : 0, d.spot.length ? d.spot[0].t : 0);
  if (from) { d.perp = ocRebase(d.perp.filter(p => p.t >= from)); d.spot = ocRebase(d.spot.filter(p => p.t >= from)); d.oi = d.oi.filter(p => p.t >= from - win.ms); }
  d.read = oicvdRead(d);
  return d;
}
/*  A trimmed CVD starts again from zero, so the panes and the read agree. */
function ocRebase(series) {
  let cum = 0;
  return series.map(p => { cum += p.delta; return Object.assign({}, p, { cum: +cum.toFixed(4) }); });
}

async function oicvdShow(force) {
  const sym = active;
  if (!$('oc-panes')) return;
  const changed = ocState.sym !== sym;
  if (changed) { ocState.sym = sym; ocState.data = null; ocState.at = 0; ocState.err = null; ocState.hover = null; renderOicvd(); }
  if (!ocState.timer) ocState.timer = setInterval(() => { if (view === 'terminal') oicvdShow(); }, OICVD_EVERY_MS);
  if (!force && !changed && ocState.at && Date.now() - ocState.at < OICVD_EVERY_MS) { renderOicvd(); return; }
  if (ocState.loading) return;
  ocState.loading = true;
  const winKey = ocState.window;
  try {
    const d = await ocFetch(sym, winKey);
    if (ocState.sym !== sym || ocState.window !== winKey) return;
    ocState.data = d; ocState.at = d.at; ocState.err = null;
  } catch (e) {
    if (ocState.sym === sym) ocState.err = e.message || 'unavailable';
  } finally {
    if (ocState.sym === sym) ocState.loading = false;
    renderOicvd();
  }
}

function oicvdSetWindow(key) {
  if (!OICVD_WINDOWS.some(w => w.key === key) || key === ocState.window) return;
  ocState.window = key; ocState.data = null; ocState.at = 0; ocState.hover = null;
  renderOicvd();
  oicvdShow(true);
}

/* ---------- drawing ---------- */

function ocCoins(v, dp) { return v == null ? '—' : (v > 0 ? '+' : '') + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(dp == null ? 1 : dp)); }
function ocPct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function ocWhen(t, win) {
  const d = new Date(t);
  return win.ms >= 14400e3 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/*  One pane: a line (or a zero-anchored area for a CVD) on its own scale.
    All panes share `n` bars and the same x, so hovering one hovers all.   */
function ocPane(series, key, opts) {
  const o = opts || {};
  const W = 600, H = o.height || 60, P = 3;
  const vs = series.map(p => p[key]).filter(v => v != null && isFinite(v));
  if (vs.length < 2) return '<div class="ocnone">' + nvEsc(o.empty || 'no data') + '</div>';
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (o.zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const n = o.n || series.length;
  const x = i => P + i / Math.max(1, n - 1) * (W - 2 * P);
  const y = v => H - P - (v - lo) / (hi - lo) * (H - 2 * P);
  const pts = series.map((p, i) => ({ x: x(i), y: p[key] == null ? null : y(p[key]) })).filter(p => p.y != null);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  const last = vs[vs.length - 1];
  const col = o.color || (o.zero ? (last >= 0 ? 'var(--up)' : 'var(--down)') : 'var(--focus)');
  let body = '';
  if (o.zero) {
    const y0 = y(0).toFixed(1);
    body += '<line x1="' + P + '" x2="' + (W - P) + '" y1="' + y0 + '" y2="' + y0 + '" class="ocmid"/>';
    body += '<path d="' + path + ' L' + pts[pts.length - 1].x.toFixed(1) + ' ' + y0 + ' L' + pts[0].x.toFixed(1) + ' ' + y0 + ' Z" fill="' + col + '" fill-opacity=".12" stroke="none"/>';
  }
  body += '<path d="' + path + '" fill="none" stroke="' + col + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
  if (ocState.hover != null && ocState.hover < n) {
    const hx = x(ocState.hover).toFixed(1);
    body += '<line x1="' + hx + '" x2="' + hx + '" y1="0" y2="' + H + '" class="ochair"/>';
  }
  return '<svg class="ocsvg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="' + nvEsc(o.label || '') + '">' + body + '</svg>';
}

function renderOicvd() {
  const panes = $('oc-panes');
  if (!panes) return;
  const sub = $('oc-sub'), rd = $('oc-read'), note = $('oc-note'), winBox = $('oc-win'), hov = $('oc-hover');
  if (winBox) winBox.querySelectorAll('[data-oc-win]').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-oc-win') === ocState.window);
    if (!b.onclick) b.onclick = () => oicvdSetWindow(b.getAttribute('data-oc-win'));
  });
  const d = ocState.data;
  if (!d) {
    panes.innerHTML = '<div class="loading">' + (ocState.err ? 'Could not load: ' + nvEsc(ocState.err) : 'Loading open interest and the tape…') + '</div>';
    rd.textContent = ''; if (hov) hov.textContent = '';
    if (sub) sub.textContent = 'price, open interest, perpetual CVD and spot CVD on one axis';
    return;
  }
  const { win, perp, spot, oi, read } = d;
  const ref = perp.length ? perp : spot;                 // the bars every pane is aligned to
  const n = ref.length;
  // the OI series mapped onto the bars' grid: the latest print at or before each bar
  const oiOnBars = ref.map(p => { let v = null; for (let i = oi.length - 1; i >= 0; i--) if (oi[i].t <= p.t) { v = oi[i].oi; break; } return { t: p.t, oi: v }; });
  const spotOnBars = ref.map(p => { const s = spot.find(q => q.t === p.t); return { t: p.t, cum: s ? s.cum : null }; });
  const i = ocState.hover != null && ocState.hover < n ? ocState.hover : n - 1;
  const at = ref[i];
  const oiAt = oiOnBars[i] ? oiOnBars[i].oi : null;
  const spotAt = spotOnBars[i] ? spotOnBars[i].cum : null;
  const oiLast = oi.length ? oi[oi.length - 1] : null;

  const row = (label, value, meta, paneHtml, cls) =>
    '<div class="ocrow ' + (cls || '') + '"><div class="oclab"><span>' + label + '</span><b>' + value + '</b><em>' + meta + '</em></div><div class="ocpane">' + paneHtml + '</div></div>';
  panes.innerHTML =
    row('Price', at && at.close != null ? fmtUsd(at.close) : '—', ocPct(read.priceChg) + ' over ' + win.key,
        ocPane(ref, 'close', { n, label: 'price', color: 'var(--ink)', height: 56 })) +
    row('Open interest', oiAt != null ? Math.round(oiAt).toLocaleString() + ' ' + nvEsc(d.sym) : '—',
        (oiLast && isFinite(oiLast.oiUsd) ? '$' + fmtVol(oiLast.oiUsd) + ' · ' : '') + ocPct(read.oiChg) + ' over ' + win.key,
        ocPane(oiOnBars, 'oi', { n, label: 'open interest', color: '#6E7BFF', height: 56, empty: 'no open-interest history' })) +
    row('CVD · perp', ocCoins(at ? at.cum : null) + ' ' + nvEsc(d.sym), 'taker buys − sells, perpetual, since the window began',
        ocPane(ref, 'cum', { n, label: 'perpetual CVD', zero: true, height: 64 }), read.perpCvd == null ? '' : read.perpCvd >= 0 ? 'up' : 'down') +
    row('CVD · spot', spotAt != null ? ocCoins(spotAt) + ' ' + nvEsc(d.sym) : '—', spot.length ? 'taker buys − sells, spot, since the window began' : 'Binance has no spot market for this coin',
        ocPane(spotOnBars, 'cum', { n, label: 'spot CVD', zero: true, height: 64, empty: 'no spot market on Binance' }), read.spotCvd == null ? '' : read.spotCvd >= 0 ? 'up' : 'down') +
    '<div class="ocaxis"><span>' + (n ? ocWhen(ref[0].t, win) : '') + '</span><span>' + (win.interval + ' bars · Binance') + '</span><span>now</span></div>';
  if (hov) hov.textContent = at ? ocWhen(at.t, win) + (ocState.hover != null && ocState.hover < n - 1 ? '' : ' · latest bar') : '';

  // pointer → bar
  panes.onmousemove = e => {
    const pane = e.target.closest('.ocpane'); if (!pane) return;
    const r = pane.getBoundingClientRect();
    const idx = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left) / r.width * (n - 1))));
    if (idx !== ocState.hover) { ocState.hover = idx; renderOicvd(); }
  };
  panes.onmouseleave = () => { if (ocState.hover != null) { ocState.hover = null; renderOicvd(); } };

  if (sub) sub.textContent = d.sym + ' · Binance perpetual and spot · last ' + win.key + ' · refreshed ' + new Date(d.at).toLocaleTimeString();

  // the read
  const bits = [];
  if (read.positions) bits.push('<b>' + nvEsc(read.positions) + '</b> <span class="ocwhy">' + nvEsc(read.posWhy) + '</span>');
  if (read.led) bits.push('<b>' + nvEsc(read.led) + '</b> <span class="ocwhy">' + nvEsc(read.ledWhy) + '</span>');
  if (read.flow) bits.push('<b>' + nvEsc(read.flow) + '</b> <span class="ocwhy">' + nvEsc(read.flowWhy) + '</span>');
  rd.innerHTML = bits.length
    ? bits.join('<br>') + (read.lean ? '<span class="lsrlean ' + read.lean + '">lean ' + (read.lean === 'bull' ? 'long' : 'short') + '</span>' : '')
    : 'Not enough to read yet.';
  if (note) note.textContent = 'CVD = the running sum of taker buys minus taker sells, in coins, restarted at zero at the left edge — read the slope and the shape, not the level. ' +
    'Open interest rising with price is longs opening; rising into a falling price is shorts opening; falling is positions closing (short covering if price rises, longs closing if it falls). ' +
    'Spot and perp CVD pulling apart says which market is leading: spot buying while perps sell is money coming in against leverage; the reverse is a move carried by leverage alone.' +
    (d.notes.length ? ' Not available this refresh: ' + d.notes.join('; ') + '.' : '');
}

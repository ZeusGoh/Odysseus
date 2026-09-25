/* lsr.js — the long/short ratio across exchanges: taker buy volume against
   taker sell volume on a coin's perpetual, exchange by exchange, added up.

   The ratio Coinglass shows on its Long/Short page is not who HOLDS what —
   it is who is HITTING the market: the volume of trades where the aggressor
   bought (a long opening or a short closing at the ask) against the volume
   where the aggressor sold. Over an hour, four hours, a day. It is the
   pressure behind a move rather than the positioning left over from it.

   Three exchanges publish it in hourly buckets a browser can read with no
   key — Binance, Bitget and Gate — so any window is a sum of buckets. Bybit
   and OKX publish only the tape, so for those the app listens to the trade
   stream from the moment the Terminal opens and sums it into the same
   hourly buckets; their rows say how much of the window the tape covers,
   and they join the total only once it covers all of it.

   Volumes come in coins and are shown in dollars at the current price —
   the same convention every long/short board uses, and close enough over a
   day. Pure: raw rows in, one shape out; the fetching, the sockets and the
   drawing are in ui-lsr.js.
   part of Odysseus */

/* ==LSR_START== */
const LSR_HOUR = 3600e3;
const LSR_KEEP_H = 72;                   // hours of buckets kept, and drawn
const LSR_MIN_EXCHANGES = 2;             // an aggregate of one feed is that feed, and is labelled so
const LSR_PRESS = 55;                    // taker buy share above this is buyers pressing; below 100−this, sellers

const LSR_WINDOWS = [
  { key: '1h',  hours: 1 },
  { key: '4h',  hours: 4 },
  { key: '24h', hours: 24 },
];

const LSR_EXCHANGES = [
  { key: 'binance', label: 'Binance', how: 'buckets' },
  { key: 'okx',     label: 'OKX',     how: 'tape' },
  { key: 'bybit',   label: 'Bybit',   how: 'tape' },
  { key: 'gate',    label: 'Gate',    how: 'buckets' },
  { key: 'bitget',  label: 'Bitget',  how: 'buckets' },
];

function lsrHour(t) { return Math.floor(+t / LSR_HOUR) * LSR_HOUR; }

/*  Hourly buckets of taker volume in coins, ascending, one per hour:
    [{t, buy, sell}]. Rows with a broken number are dropped, not zeroed.  */
function lsrBuckets(rows, tOf, buyOf, sellOf) {
  const out = [];
  for (const r of rows || []) {
    const t = lsrHour(tOf(r)), buy = +buyOf(r), sell = +sellOf(r);
    if (!isFinite(t) || !isFinite(buy) || !isFinite(sell) || buy < 0 || sell < 0) continue;
    out.push({ t, buy, sell });
  }
  return out.sort((a, b) => a.t - b.t);
}

/*  Binance USDⓈ-M: takerlongshortRatio, period=1h — buyVol/sellVol in coins,
    newest last. Binance publishes an hour only once it has closed, so the
    hour under way is missing from that list; the 5-minute rows are live,
    and they fill in any hour the hourly list does not have yet.          */
function lsrFromBinanceTaker(rows1h, rows5m) {
  const hourly = lsrBuckets(rows1h, r => r.timestamp, r => r.buyVol, r => r.sellVol);
  const have = new Set(hourly.map(b => b.t));
  const fill = new Map();
  for (const b of lsrBuckets(rows5m, r => r.timestamp, r => r.buyVol, r => r.sellVol)) {
    if (have.has(b.t)) continue;
    const slot = fill.get(b.t) || { t: b.t, buy: 0, sell: 0 };
    slot.buy += b.buy; slot.sell += b.sell;
    fill.set(b.t, slot);
  }
  return hourly.concat([...fill.values()]).sort((a, b) => a.t - b.t);
}

/*  Bitget: taker-buy-sell, period=1h — buyVolume/sellVolume in coins, ts in
    ms, oldest first.                                                     */
function lsrFromBitgetTaker(rows) { return lsrBuckets(rows, r => r.ts, r => r.buyVolume, r => r.sellVolume); }

/*  Gate: contract_stats, interval=1h — long_taker_size/short_taker_size in
    contracts of `quanto` coins each; time in seconds.                    */
function lsrFromGateTaker(rows, quanto) {
  const q = isFinite(+quanto) && +quanto > 0 ? +quanto : null;
  if (!q) return [];
  return lsrBuckets(rows, r => r.time * 1000, r => +r.long_taker_size * q, r => +r.short_taker_size * q);
}

/* ---------- the tape, for exchanges that publish nothing else ---------- */

/*  A tape is the same hourly buckets, built trade by trade from a stream
    that started at `since`. Trades: [{t, side:'buy'|'sell', size}] in
    coins. The bucket map is keyed by hour so a trade lands in O(1).      */
function lsrTapeNew(since) { return { since: +since, buckets: new Map(), trades: 0 }; }

function lsrTapeAdd(tape, trades) {
  for (const x of trades || []) {
    const t = lsrHour(x.t), size = +x.size;
    if (!isFinite(t) || !isFinite(size) || size <= 0) continue;
    const b = tape.buckets.get(t) || { t, buy: 0, sell: 0 };
    if (x.side === 'buy') b.buy += size; else if (x.side === 'sell') b.sell += size; else continue;
    tape.buckets.set(t, b); tape.trades++;
  }
  return tape;
}

function lsrTapeBuckets(tape, now) {
  const floor = lsrHour(now == null ? Date.now() : now) - LSR_KEEP_H * LSR_HOUR;
  for (const k of [...tape.buckets.keys()]) if (k < floor) tape.buckets.delete(k);
  return [...tape.buckets.values()].sort((a, b) => a.t - b.t);
}

/* ---------- windows ---------- */

/*  The last `hours` hourly buckets, the current (partial) hour included —
    "4h" is this hour and the three before it. Sum in coins.             */
function lsrWindow(buckets, hours, now) {
  const from = lsrHour(now == null ? Date.now() : now) - (Math.max(1, hours) - 1) * LSR_HOUR;
  let buy = 0, sell = 0, n = 0;
  for (const b of buckets || []) if (b.t >= from) { buy += b.buy; sell += b.sell; n++; }
  return { buy, sell, n, from };
}

function lsrShares(buy, sell) {
  const tot = buy + sell;
  if (!(tot > 0)) return { longPct: null, shortPct: null, ratio: null };
  return { longPct: +(buy / tot * 100).toFixed(2), shortPct: +(sell / tot * 100).toFixed(2), ratio: sell > 0 ? +(buy / sell).toFixed(2) : null };
}

/*  One exchange over one window: volumes in coins and dollars, the shares,
    and — for a tape — how much of the window the stream has seen.       */
function lsrExchange(key, buckets, price, hours, opts) {
  const o = opts || {};
  const meta = LSR_EXCHANGES.find(e => e.key === key) || { key, label: key, how: 'buckets' };
  const now = o.now == null ? Date.now() : o.now;
  const w = lsrWindow(buckets, hours, now);
  const px = isFinite(+price) && +price > 0 ? +price : null;
  const shares = lsrShares(w.buy, w.sell);
  let coverage = null, covered = true;
  if (meta.how === 'tape') {
    const since = o.since == null ? null : +o.since;
    if (since == null) { coverage = 0; covered = false; }
    else {
      const need = now - w.from;                      // the window's real span, this hour partial
      coverage = Math.max(0, Math.min(1, (now - since) / need));
      covered = coverage >= 0.999;
    }
  }
  const has = w.buy + w.sell > 0;
  return Object.assign({ key: meta.key, label: meta.label, how: meta.how, hours,
    buy: has ? w.buy : null, sell: has ? w.sell : null,
    buyUsd: has && px ? w.buy * px : null, sellUsd: has && px ? w.sell * px : null,
    volumeUsd: has && px ? (w.buy + w.sell) * px : null,
    buckets: w.n, coverage, covered, since: o.since == null ? null : +o.since,
    missing: o.missing || null }, shares);
}

/*  The total: dollars summed over the exchanges that cover the window in
    full, and every exchange's share of that volume. A tape still filling
    is listed, and left out of the sum until it has the whole window.     */
function lsrAggregate(exchanges) {
  const list = (exchanges || []).filter(Boolean);
  const inSum = list.filter(e => e.covered && e.buyUsd != null);
  const buyUsd = inSum.reduce((s, e) => s + e.buyUsd, 0), sellUsd = inSum.reduce((s, e) => s + e.sellUsd, 0);
  const vol = buyUsd + sellUsd;
  const shares = lsrShares(buyUsd, sellUsd);
  return Object.assign({
    buyUsd: vol > 0 ? buyUsd : null, sellUsd: vol > 0 ? sellUsd : null, volumeUsd: vol > 0 ? vol : null,
    n: inSum.length, partial: list.filter(e => !e.covered && e.buyUsd != null).map(e => e.key),
    exchanges: list.map(e => Object.assign({}, e, { share: e.covered && e.volumeUsd != null && vol > 0 ? +(e.volumeUsd / vol * 100).toFixed(1) : null }))
      .sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0)),
  }, shares);
}

/*  The aggregate hour by hour, for the line: at each hour the buy share of
    the summed coins over the exchanges with a bucket there, hours with
    fewer than LSR_MIN_EXCHANGES dropped. Tapes count only for hours they
    saw whole, so a stream that joined at :40 does not tilt that hour.    */
function lsrSeries(feeds, now) {
  const byHour = new Map();
  const t0 = lsrHour(now == null ? Date.now() : now) - LSR_KEEP_H * LSR_HOUR;
  for (const f of feeds || []) {
    if (!f || !f.buckets) continue;
    const firstWhole = f.since == null ? -Infinity : lsrHour(f.since) + LSR_HOUR;
    for (const b of f.buckets) {
      if (b.t < t0 || b.t < firstWhole) continue;
      const s = byHour.get(b.t) || { t: b.t, buy: 0, sell: 0, n: 0 };
      s.buy += b.buy; s.sell += b.sell; s.n++;
      byHour.set(b.t, s);
    }
  }
  return [...byHour.values()].filter(s => s.n >= LSR_MIN_EXCHANGES && s.buy + s.sell > 0).sort((a, b) => a.t - b.t)
    .map(s => ({ t: s.t, v: +(s.buy / (s.buy + s.sell) * 100).toFixed(1), n: s.n }));
}

/*  The read: who is pressing, and whether price is going their way. Taker
    flow one way with price going the other is absorption — the side that
    is hitting is not getting paid, and that is the fuel a squeeze runs on.
    `priceChgPct` is the move over the same window; null reads flow alone. */
function lsrRead(agg, priceChgPct) {
  const lp = agg ? agg.longPct : null;
  if (lp == null) return { side: null, word: null, lean: null, why: null };
  const side = lp >= LSR_PRESS ? 'buy' : lp <= 100 - LSR_PRESS ? 'sell' : null;
  const word = side === 'buy' ? 'buyers pressing' : side === 'sell' ? 'sellers pressing' : 'balanced tape';
  const pc = priceChgPct == null || !isFinite(+priceChgPct) ? null : +priceChgPct;
  let lean = null, why;
  if (!side) why = 'neither side is hitting the market hard enough to read';
  else if (pc == null) why = (side === 'buy' ? 'more aggressor volume buying than selling' : 'more aggressor volume selling than buying') + ' over the window';
  else if (side === 'buy' && pc > 0) { lean = 'bull'; why = 'buyers hitting and price following — the flow is getting paid'; }
  else if (side === 'sell' && pc < 0) { lean = 'bear'; why = 'sellers hitting and price following — the flow is getting paid'; }
  else if (side === 'buy') { lean = 'bear'; why = 'buyers hitting into a falling price — absorbed; longs are paying up and not getting paid'; }
  else { lean = 'bull'; why = 'sellers hitting into a rising price — absorbed; that is what squeezes run on'; }
  return { side, word, lean, why, longPct: lp, priceChgPct: pc };
}

/*  Price change over the last `hours` from hourly candles ascending
    ({t,o,h,l,c}): the close now against the open of the bucket that starts
    the window. Null when the candles do not reach back that far.        */
function lsrPriceChange(candles, hours, now) {
  const cs = (candles || []).filter(c => c && isFinite(+c.t) && isFinite(+c.c));
  if (!cs.length) return null;
  const from = lsrHour(now == null ? Date.now() : now) - (Math.max(1, hours) - 1) * LSR_HOUR;
  if (cs[0].t > from) return null;                 // the candles do not reach back that far
  const first = cs.find(c => c.t >= from);
  const last = cs[cs.length - 1];
  if (!first || !(first.o > 0)) return null;
  return +((last.c - first.o) / first.o * 100).toFixed(2);
}
/* ==LSR_END== */

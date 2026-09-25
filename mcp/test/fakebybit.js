/* fakebybit.js — a deterministic stand-in for Bybit (and the news feeds).

   This exists because the MCP engine must be testable without the exchange.
   It is committed on purpose: the last version of it lived in a scratch
   directory, the sandbox it lived in went away, and the whole verification
   story went with it.

   Everything it serves is generated from a seeded PRNG, so the same symbol
   always produces the same candles and a test can assert on exact numbers.
   The board is built to contain one of each case the engine has to handle:

     BTC   — the reference, a small move
     ETH…  — an ordinary liquid board, which sets the median
     SQUEZ — a large coin-specific move on falling open interest (a squeeze)
     ORDIN — a moderate move of its own, still coin-specific
     THINB — a real move on a book under the liquidity floor
     OFFBD — tradeable candles but absent from the board entirely

   Usage:  const {start} = require('./fakebybit');
           const srv = await start();          // { url, port, close() }
   part of Odysseus */

'use strict';

const http = require('http');

/* ---------- deterministic randomness ---------- */

function seedOf(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- the board ---------- */

const MAJORS = [
  ['BTC',  67000,  4200e6,  0.00005],
  ['ETH',   3100,  2100e6,  0.00008],
  ['SOL',    170,   900e6,  0.00012],
  ['XRP',   0.62,   640e6,  0.00002],
  ['BNB',    590,   410e6,  0.00001],
  ['DOGE',  0.14,   380e6,  0.00009],
  ['ADA',   0.47,   240e6,  0.00003],
  ['AVAX',    29,   180e6,  0.00007],
  ['LINK',    15,   160e6,  0.00006],
  ['SUI',   1.05,   140e6,  0.00011],
  ['TON',   5.40,   110e6,  0.00004],
  ['LTC',     84,    95e6,  0.00002],
  ['NEAR',  4.10,    72e6,  0.00010],
  ['ARB',   0.78,    58e6,  0.00005],
  ['ZEC',     32,    41e6,  0.00003],
];

/*  The interesting cases. `target` is the exact 24h close-to-close return the
    series is forced to, `sharpAt` how many hours back the damage landed.     */
const SPECIALS = [
  { sym: 'SQUEZ', price: 0.0410, turnover:  86e6, funding:  0.00090, target:  28.0, sharpAt: 5, oi: -18 },
  { sym: 'ORDIN', price: 2.7500, turnover:  33e6, funding:  0.00012, target:   6.4, sharpAt: 9, oi:  11 },
  { sym: 'THINB', price: 0.0031, turnover: 2.4e6, funding:  0.00004, target:  19.5, sharpAt: 3, oi:   4 },
];

// on the exchange, but never on the tickers board — the engine must cope
const OFFBOARD = { sym: 'OFFBD', price: 0.9200, target: 3.2, sharpAt: 14 };

const NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', BNB: 'BNB',
  DOGE: 'Dogecoin', ADA: 'Cardano', AVAX: 'Avalanche', LINK: 'Chainlink',
  SUI: 'Sui', TON: 'Toncoin', LTC: 'Litecoin', NEAR: 'NEAR', ARB: 'Arbitrum',
  ZEC: 'Zcash', SQUEZ: 'Squeezer', ORDIN: 'Ordinal Coin', THINB: 'Thinbook',
  OFFBD: 'Offboard Token',
};

function allSymbols() {
  return [
    ...MAJORS.map(([sym, price, turnover, funding]) => ({ sym, price, turnover, funding, target: null })),
    ...SPECIALS,
    OFFBOARD,
  ];
}

function boardSymbols() {
  return allSymbols().filter(s => s.sym !== OFFBOARD.sym);
}

function specOf(sym) {
  return allSymbols().find(s => s.sym === sym) || null;
}

/* ---------- candles ---------- */

const MS = { '60': 3600e3, '240': 14400e3, 'D': 86400e3, 'W': 604800e3 };

/*  Bars are aligned to their interval so barClose() in the app lands where it
    should and the newest bar reads as live.                                  */
function barStarts(interval, count, now) {
  const out = [];
  if (interval === 'M') {
    const d = new Date(now);
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    for (let i = 0; i < count; i++) {
      out.unshift(Date.UTC(y, m, 1));
      m--; if (m < 0) { m = 11; y--; }
    }
    return out;
  }
  const ms = MS[interval] || 3600e3;
  const last = Math.floor(now / ms) * ms;
  for (let i = count - 1; i >= 0; i--) out.push(last - i * ms);
  return out;
}

/*  A mean-reverting walk: enough structure that the stochastic actually
    crosses, tops and bottoms, and prints divergences, rather than the clean
    ramp a naive generator produces (on which nothing ever crosses).         */
function walk(sym, interval, count, base) {
  const r = rng(seedOf(sym + '|' + interval));
  const out = [];
  let px = base;
  let drift = 0;
  const vol = interval === '60' ? 0.006 : interval === '240' ? 0.013 : interval === 'D' ? 0.026 : 0.06;

  for (let i = 0; i < count; i++) {
    drift = drift * 0.86 + (r() - 0.5) * vol;          // momentum that decays
    const pull = (base - px) / base * 0.02;            // and a tether to the mean
    px = px * (1 + drift + pull);
    const wick = px * vol * (0.4 + r() * 0.8);
    const o = out.length ? out[out.length - 1].c : px * (1 - drift / 2);
    const c = px;
    const h = Math.max(o, c) + wick * r();
    const l = Math.min(o, c) - wick * r();
    out.push({ o, h, l, c, v: 900 + r() * 700 });
  }
  return out;
}

/*  Force the last `hours` bars to land on an exact close-to-close return, with
    most of it inside one hour, so a test can assert the classification and the
    sharpest-hour read rather than hoping the walk cooperates.               */
function applyTarget(bars, targetPct, sharpAt) {
  const n = bars.length;
  const hours = 24;
  if (n < hours + 2 || targetPct == null) return bars;

  const from = n - 1 - hours;
  const anchor = bars[from].c;

  /*  The window is rebuilt as a chain of per-bar returns rather than scaled in
      place: scaling open, high, low and close by the same factor leaves the
      bar's own open-to-close move exactly as it was, so the "sharpest hour"
      never actually became sharp. Here the sharp bar gets most of the move as
      its own o→c return, which is what nvSharpest is looking for.           */
  const sharpIdx = n - 1 - sharpAt;
  const total = 1 + targetPct / 100;
  const sharpStep = Math.pow(total, 0.65);
  const restStep = Math.pow(total / sharpStep, 1 / (hours - 1));
  const r = rng(seedOf('target|' + n + '|' + Math.round(targetPct * 100)));

  let px = anchor;
  for (let i = from + 1; i < n; i++) {
    const step = i === sharpIdx ? sharpStep : restStep;
    const o = px;
    const c = px * step;
    const spread = Math.abs(step - 1) * 0.35 + 0.0015;
    bars[i].o = o;
    bars[i].c = c;
    bars[i].h = Math.max(o, c) * (1 + spread * r());
    bars[i].l = Math.min(o, c) * (1 - spread * r());
    bars[i].v = 900 + r() * 700;
    if (i === sharpIdx) bars[i].v *= 6.5;               // the volume tell
    px = c;
  }
  return bars;
}

const candleCache = new Map();

function candles(sym, interval, count, now) {
  const key = sym + '|' + interval + '|' + count + '|' + now;
  if (candleCache.has(key)) return candleCache.get(key);

  const spec = specOf(sym) || { price: 1, target: null, sharpAt: 6 };
  const starts = barStarts(interval, count, now);
  let bars = walk(sym, interval, count, spec.price);
  if (interval === '60') bars = applyTarget(bars, spec.target, spec.sharpAt || 6);

  const out = bars.map((b, i) => ({
    t: starts[i],
    o: +b.o.toFixed(10), h: +b.h.toFixed(10), l: +b.l.toFixed(10), c: +b.c.toFixed(10),
    v: +b.v.toFixed(4),
  }));
  candleCache.set(key, out);
  return out;
}

function lastPrice(sym, now) {
  const c = candles(sym, '60', 1200, now);
  return c[c.length - 1].c;
}

/* ---------- headlines ---------- */

const HEADLINES = [
  { src: 'Cointelegraph', title: 'Bitcoin holds above $67,000 as volatility compresses',
    body: 'BTC traded in a narrow band overnight.', hoursAgo: 3 },
  { src: 'CoinDesk', title: 'Ether ETF flows turn positive for a third session',
    body: 'ETH inflows continued.', hoursAgo: 7 },
];

// a real catalyst for SQUEZ, published just before its sharpest hour
const COIN_NEWS = {
  SQUEZ: [{ src: 'Google News', title: 'Squeezer (SQUEZ) confirmed for major exchange listing',
            body: 'The SQUEZ token will be listed on a top-five venue.', hoursAgo: 6 }],
  ORDIN: [],
};

const EXCHANGE_ANN = [
  { title: 'Bybit Will List Squeezer (SQUEZ) Perpetual Contract', hoursAgo: 6 },
];

function rssItems(now, items) {
  return items.map(it => ({
    title: it.title,
    link: 'https://example.invalid/' + encodeURIComponent(it.title.slice(0, 40)),
    pubDate: new Date(now - it.hoursAgo * 3600e3).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
    description: it.body || '',
  }));
}

/* ---------- the server ---------- */

function start(opts) {
  const o = opts || {};
  const now = o.now || Date.now();

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const q = u.searchParams;
    const send = (obj, code) => {
      const body = JSON.stringify(obj);
      res.writeHead(code || 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const ok = result => send({ retCode: 0, retMsg: 'OK', result, time: now });

    try {
      if (p === '/v5/market/tickers') {
        const one = q.get('symbol');
        const list = boardSymbols()
          .filter(s => !one || s.sym + 'USDT' === one)
          .map(s => ({
            symbol: s.sym + 'USDT',
            lastPrice: String(lastPrice(s.sym, now)),
            turnover24h: String(s.turnover),
            fundingRate: String(s.funding),
            openInterestValue: String(s.turnover * 0.42),
            price24hPcnt: '0',
          }));
        return ok({ category: q.get('category') || 'linear', list });
      }

      if (p === '/v5/market/kline') {
        const sym = String(q.get('symbol') || '').replace(/USDT$/, '');
        if (!specOf(sym)) return send({ retCode: 10001, retMsg: 'symbol ' + sym + ' not found' });
        const interval = q.get('interval') || '60';
        const limit = Math.min(+q.get('limit') || 200, 1000);
        const end = q.get('end') ? +q.get('end') : null;

        const depth = interval === '60' ? 1200 : interval === 'M' ? 40 : 700;
        let series = candles(sym, interval, depth, now);
        if (end) series = series.filter(c => c.t <= end);
        const page = series.slice(-limit);
        const list = page
          .map(c => [String(c.t), String(c.o), String(c.h), String(c.l), String(c.c), String(c.v), String(c.v * c.c)])
          .reverse();                                   // Bybit hands back newest first
        return ok({ symbol: sym + 'USDT', category: q.get('category') || 'linear', list });
      }

      if (p === '/v5/market/open-interest') {
        const sym = String(q.get('symbol') || '').replace(/USDT$/, '');
        const spec = specOf(sym);
        if (!spec) return send({ retCode: 10001, retMsg: 'symbol not found' });
        const pct = spec.oi == null ? 0.4 : spec.oi;
        const startOi = 1e6;
        const n = 25;
        const list = [];
        for (let i = 0; i < n; i++) {
          const frac = i / (n - 1);
          list.push({
            openInterest: String(startOi * (1 + (pct / 100) * frac)),
            timestamp: String(now - (n - 1 - i) * 3600e3),
          });
        }
        return ok({ category: 'linear', symbol: sym + 'USDT', list: list.reverse() });
      }

      /*  The positioning series the crowd tool reads. The share of accounts
          long drifts from its resting level toward `spec.ratio`; funding
          repeats the ticker's rate every eight hours.                     */
      if (p === '/v5/market/account-ratio') {
        const sym = String(q.get('symbol') || '').replace(/USDT$/, '');
        const spec = specOf(sym);
        if (!spec) return send({ retCode: 10001, retMsg: 'symbol not found' });
        const target = spec.ratio == null ? 0.55 : spec.ratio;
        const n = Math.min(+q.get('limit') || 50, 200);
        const list = [];
        for (let i = 0; i < n; i++) {
          const frac = i / Math.max(1, n - 1);
          const buy = 0.5 + (target - 0.5) * frac;
          list.push({ buyRatio: buy.toFixed(4), sellRatio: (1 - buy).toFixed(4), timestamp: String(now - (n - 1 - i) * 3600e3) });
        }
        return ok({ category: 'linear', symbol: sym + 'USDT', list: list.reverse() });
      }

      if (p === '/v5/market/funding/history') {
        const sym = String(q.get('symbol') || '').replace(/USDT$/, '');
        const spec = specOf(sym);
        if (!spec) return send({ retCode: 10001, retMsg: 'symbol not found' });
        const n = Math.min(+q.get('limit') || 30, 200);
        const list = [];
        for (let i = 0; i < n; i++)
          list.push({ symbol: sym + 'USDT', fundingRate: String(spec.funding), fundingRateTimestamp: String(now - (n - 1 - i) * 8 * 3600e3) });
        return ok({ category: 'linear', list: list.reverse() });
      }

      if (p === '/v5/market/instruments-info') {
        const list = boardSymbols().map(s => ({
          symbol: s.sym + 'USDT', status: 'Trading', baseCoin: s.sym,
          quoteCoin: 'USDT', contractType: 'LinearPerpetual',
        }));
        list.push({ symbol: OFFBOARD.sym + 'USDT', status: 'Trading', baseCoin: OFFBOARD.sym,
                    quoteCoin: 'USDT', contractType: 'LinearPerpetual' });
        return ok({ category: q.get('category') || 'linear', list });
      }

      if (p === '/v5/announcements/index') {
        return ok({
          list: EXCHANGE_ANN.map(a => ({
            title: a.title, url: 'https://example.invalid/ann',
            description: '', publishTime: now - a.hoursAgo * 3600e3,
          })),
        });
      }

      // rss2json stand-in: the shared desk feeds, and Google News per-coin search
      if (p === '/v1/api.json') {
        const target = String(q.get('rss_url') || '');
        if (/news\.google\.com/.test(target)) {
          const m = decodeURIComponent(target).match(/q=([^&]+)/);
          const query = m ? decodeURIComponent(m[1]) : '';
          const sym = Object.keys(COIN_NEWS).find(s =>
            query.toUpperCase().includes(s) || query.toUpperCase().includes((NAMES[s] || '').toUpperCase()));
          return send({ status: 'ok', items: rssItems(now, COIN_NEWS[sym] || []) });
        }
        return send({ status: 'ok', items: rssItems(now, HEADLINES) });
      }

      // CoinGecko stand-in, for the name resolution
      if (p === '/api/v3/coins/markets') {
        const page = +q.get('page') || 1;
        if (page > 1) return send([]);
        return send(Object.entries(NAMES).map(([sym, name]) => ({
          symbol: sym.toLowerCase(), name, image: 'https://example.invalid/large/' + sym + '.png',
        })));
      }

      // Binance announcements stand-in
      if (p.startsWith('/bapi/')) {
        return send({ data: { catalogs: [{ articles: [] }] } });
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no fake route for ' + p }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  return new Promise(resolve => {
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: 'http://127.0.0.1:' + port,
        now,
        /*  Everything the engine talks to, pointed here. Hand this straight to
            new Engine({hostMap}) or JSON.stringify it into ODYSSEUS_HOST_MAP. */
        hostMap: {
          'api.bybit.com': 'http://127.0.0.1:' + port,
          'api.rss2json.com': 'http://127.0.0.1:' + port,
          'api.coingecko.com': 'http://127.0.0.1:' + port,
          'www.binance.com': 'http://127.0.0.1:' + port,
        },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

module.exports = { start, allSymbols, boardSymbols, specOf, candles, NAMES, OFFBOARD, SPECIALS };

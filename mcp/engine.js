/* engine.js — the Odysseus MCP engine.

   The one rule this file obeys: it does not reimplement any of the app's maths.
   The stochastic calculation, cross detection, divergence walk, verdict-engine
   grading, board-sweep decomposition and headline matcher are all the literal
   same code the browser runs — loaded out of ../js into a Node VM context via
   the app's own tests/harness.js, with a real fetch and a no-op DOM swapped in
   where the browser would have been. A second copy of any of that maths would
   drift from the app within a week and quietly start disagreeing with it.

   What IS written here, and only here:
     - the plumbing the browser normally does through the UI (which symbols to
       load, when, and how often), and
     - the shaping of the results into JSON an analyst can read.

   Two sweep loops are re-driven rather than called: newsScan() and ensureBtc()
   are welded to the DOM and to the app's own caching, and newsScan additionally
   filters the board down to the top twenty movers — which is exactly wrong for
   a tool that must answer about any coin, moving or not. Every value inside
   those loops still comes from the app's own functions.

   Everything here is read-only. Nothing in this file writes to disk, to the
   exchange, or to the user's app state.
   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const harness = require('../tests/harness.js');

/* The app files the engine needs, in index.html's order. Order matters:
   verdict.js closes over things backtest.js and btc-reference.js define. */
const APP_FILES = [
  'indicators.js',    // stochastic, crosses, divergence, EMA 200
  'market-data.js',   // TFS/WEIGHTS, the Bybit client, pull(), SYMBOLS, symbolOf()
  'storage.js',       // the store object (never written to from here)
  'state.js',         // data/stoch/states/divsAll/divNow + analyse()
  'backtest.js',      // HORIZONS, replayCrosses, summarise, historyFor
  'btc-reference.js', // alignBtc, btcVerdict
  'verdict.js',       // assessTrade, bestTrade
  'news.js',          // the board sweep's maths, headlines, nvStructural
  'crowd.js',         // crowdMetrics, crowdScore, crowdSeries — the positioning read
  'ui-terminal.js',   // histEdge — the per-coin backtest cache assessTrade reads
  'ui-symbols.js',    // loadUniverse, so symbolOf resolves real Bybit pairs
];

const WINDOWS = ['1h', '4h', '24h'];

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/*  The browser's fetch takes options Node's does not always accept, and tests
    need the exchange pointed somewhere else entirely. Both are handled in one
    place so nothing downstream knows the difference.                        */
function makeFetch(hostMap, impl) {
  const base = impl || globalThis.fetch;
  if (typeof base !== 'function')
    throw new Error('no fetch available — Node 18+ is required');
  const map = hostMap || {};
  return async function odysseusFetch(input, init) {
    let url = typeof input === 'string' ? input : String(input);
    const to = map[hostOf(url)];
    if (to) url = rehost(url, to);
    const opts = Object.assign({}, init);
    delete opts.cache;   // browser-only; undici rejects some values
    delete opts.mode;    // browser-only, meaningless outside a page
    return base(url, opts);
  };
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return ''; }
}

function rehost(url, origin) {
  const u = new URL(url);
  const o = new URL(origin);
  u.protocol = o.protocol;
  u.host = o.host;
  if (o.pathname && o.pathname !== '/') u.pathname = o.pathname.replace(/\/$/, '') + u.pathname;
  return u.toString();
}

function hostMapFromEnv() {
  const raw = process.env.ODYSSEUS_HOST_MAP;
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('ODYSSEUS_HOST_MAP is not valid JSON: ' + e.message); }
}

/*  A DOM thin enough that a file which really needs a browser fails loudly,
    but not so thin that a stray $('...').textContent takes the process down.
    The app files the engine loads never touch it on the paths used here; this
    is insurance against a future edit adding one.                           */
function domStub() {
  const el = () => {
    const node = {
      style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '', value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(x) { return x; }, removeChild(x) { return x; }, insertBefore(x) { return x; },
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      addEventListener() {}, removeEventListener() {}, remove() {}, focus() {}, blur() {},
      querySelector() { return el(); }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
      children: [], firstChild: null, parentNode: null,
    };
    return node;
  };
  return {
    getElementById: () => el(),
    querySelector: () => el(),
    querySelectorAll: () => [],
    createElement: () => el(),
    createTextNode: () => el(),
    addEventListener: () => {},
    body: el(),
    documentElement: el(),
  };
}

/* ------------------------------------------------------------------ */

class Engine {
  constructor(opts) {
    const o = opts || {};
    this.market      = o.market      || process.env.ODYSSEUS_MARKET      || 'linear';
    this.minLiq      = num(o.minLiq      != null ? o.minLiq      : process.env.ODYSSEUS_MIN_LIQ,      10);
    this.boardWidth  = num(o.boardWidth  != null ? o.boardWidth  : process.env.ODYSSEUS_BOARD_WIDTH,  90);
    this.cacheMs     = num(o.cacheMs     != null ? o.cacheMs     : process.env.ODYSSEUS_CACHE_MS,     90000);
    this.watchlistPath = o.watchlistPath || path.join(__dirname, 'watchlist.json');
    // where score.js keeps the two track records; a test points this at a scratch dir
    this.verdictsDir   = o.verdictsDir || path.join(__dirname, '..', 'verdicts');

    if (this.market !== 'linear' && this.market !== 'spot')
      throw new Error('ODYSSEUS_MARKET must be "linear" or "spot", got ' + this.market);

    this.fetch = makeFetch(o.hostMap || hostMapFromEnv(), o.fetch);

    this._ctx = null;
    this._boot = null;
    this._stoch = new Map();     // symbol -> {at, promise|value}
    this._crowd = new Map();     // symbol -> {at, promise|value}
    this._board = null;          // {at, promise|value}
    this._universe = null;
  }

  /* ---------- the VM context ---------- */

  async ready() {
    if (this._ctx) return this._ctx;
    if (!this._boot) this._boot = this._build();
    return this._boot;
  }

  async _build() {
    const ctx = vm.createContext(harness.browserStub({
      fetch: this.fetch,
      document: domStub(),
      URL, URLSearchParams, TextDecoder, TextEncoder,
      // cloud.js is not loaded (it is Firebase plumbing), but storage.js and
      // news.js name vlPut in code paths the engine never takes. A no-op that
      // resolves keeps those paths honest if one is ever reached.
      vlPut: async () => false,
      queueMicrotask, structuredClone,
    }));
    harness.loadInto(ctx, APP_FILES);
    this._ctx = ctx;
    this._run(`MARKET = ${JSON.stringify(this.market)};`);
    return ctx;
  }

  /*  Top-level const/let from the app files live in the context's global
      lexical scope, not on globalThis, so assigning one needs a script run
      inside the context. Reading is fine through globalThis because the
      harness exposes the names after loading.                              */
  _run(code) {
    return vm.runInContext(code, this._ctx, { filename: '<engine>' });
  }

  get g() {
    if (!this._ctx) throw new Error('engine not ready — await engine.ready() first');
    return this._ctx;
  }

  /*  histEdge memoises the whole backtest per coin and never expires it, which
      is right for a browser tab that reloads and wrong for a long-lived
      process. Cleared in place so the closure keeps pointing at the same
      object.                                                                */
  _clearEdgeCache() {
    this._run('if (typeof edgeCache !== "undefined") { for (const k in edgeCache) delete edgeCache[k]; }');
  }

  /*  The exchange's own instrument list, so symbolOf() resolves the real pair
      for things like 1000PEPE instead of guessing SYMBOL + "USDT".          */
  async _universeOnce() {
    if (!this._universe) {
      this._universe = this.g.loadUniverse().catch(() => null);
    }
    return this._universe;
  }

  /* ---------- watchlist ---------- */

  /*  What the unattended pass scans. `scope` says how wide:
        watchlist — just the listed symbols (the default)
        app       — the app's own built-in SYMBOLS list
        board     — every liquid book on the exchange (the top ODYSSEUS_BOARD_WIDTH
                    by turnover over the $ODYSSEUS_MIN_LIQ floor), plus anything
                    listed, so a favourite that slips off the board is still read
      ODYSSEUS_WATCHLIST=board / =app sets the scope; anything else is symbols. */
  watchlist() {
    const env = process.env.ODYSSEUS_WATCHLIST;
    const scopeOf = v => (v === 'board' || v === 'app') ? v : null;
    let fromFile = { symbols: [], scope: null, exclude: [], always: null };
    try {
      const raw = JSON.parse(fs.readFileSync(this.watchlistPath, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.symbols;
      const up = a => (Array.isArray(a) ? a : []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
      fromFile = {
        symbols: up(list),
        scope: Array.isArray(raw) ? null : scopeOf(String(raw.scope || '').toLowerCase()),
        exclude: Array.isArray(raw) ? [] : up(raw.exclude),   // never scanned, whatever the scope
        // read every pass on a clock, gate or no gate; absent means the watcher's own default
        always: Array.isArray(raw) || !Array.isArray(raw.always) ? null : up(raw.always),
      };
    } catch (e) { /* no file, or an unreadable one */ }
    const ex = fromFile.exclude, always = fromFile.always;

    if (env && env.trim()) {
      const v = env.trim().toLowerCase();
      if (scopeOf(v)) return { source: 'ODYSSEUS_WATCHLIST', scope: v, symbols: fromFile.symbols, exclude: ex, always };
      const syms = env.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      if (syms.length) return { source: 'ODYSSEUS_WATCHLIST', scope: 'watchlist', symbols: syms, exclude: ex, always };
    }
    if (fromFile.symbols.length || fromFile.scope)
      return { source: this.watchlistPath, scope: fromFile.scope || 'watchlist', symbols: fromFile.symbols, exclude: ex, always };
    return {
      source: "the app's built-in symbol list",
      scope: 'app',
      symbols: (this._ctx ? this.g.SYMBOLS : []).map(s => s.sym),
      exclude: ex, always,
    };
  }

  /*  The liquid board, most traded first — the same top-N the news sweep
      measures, which is what "every coin on the app" means in practice.   */
  async boardSymbols() {
    await this.ready();
    const board = await this._boardSweep(false);
    return board.measured.map(t => t.sym);
  }

  appSymbols() {
    return (this._ctx ? this.g.SYMBOLS : []).map(s => s.sym);
  }

  /* ---------- coin identity ---------- */

  /*  A search-capable analyst handed a bare ticker will search the bare ticker,
      and the web will hand back something unrelated — the app's own matcher
      once pulled in a piece about Flock Safety's cameras for the FLOCK
      perpetual. Resolving the real name first is the fix, and it is the same
      CoinGecko-backed resolution the app's tables use.                       */
  async coinName(sym) {
    await this.ready();
    const code = String(sym || '').trim().toUpperCase();
    if (!code) return null;
    try { await this.g.nvLoadCoins(); } catch (e) { return null; }
    return this.g.nvCoinName(code, null) || null;
  }

  /* ---------- stochastic ---------- */

  async stochSnapshot(symbol, opts) {
    const o = opts || {};
    await this.ready();
    const code = String(symbol || '').trim().toUpperCase().replace(/USDT$/, '');
    if (!code) throw new Error('a symbol is required');

    const cached = this._stoch.get(code);
    if (!o.force && cached && Date.now() - cached.at < this.cacheMs) return cached.value;
    if (cached && cached.promise) return cached.promise;

    const promise = this._stochSnapshot(code).then(
      value => { this._stoch.set(code, { at: Date.now(), value }); return value; },
      err => { this._stoch.delete(code); throw err; }
    );
    this._stoch.set(code, { at: Date.now(), promise });
    return promise;
  }

  async _stochSnapshot(code) {
    const g = this.g;
    await this._universeOnce();

    // BTC is always loaded: every alt read is "does this agree with the leader".
    await this._loadSymbol(code);
    if (code !== g.BTC) await this._loadSymbol(g.BTC).catch(() => null);
    this._clearEdgeCache();

    const meta = g.symbolOf(code);
    const now = Date.now();
    const frames = {};

    for (const tf of g.TFS) {
      const st = g.states[code] && g.states[code][tf.key];
      const sr = g.stoch[code] && g.stoch[code][tf.key];
      if (!st || !sr) continue;

      const dv = g.divNow[code] && g.divNow[code][tf.key];
      const level = st.level == null ? null : +st.level.toFixed(1);

      frames[tf.key] = {
        label: tf.label,
        weight: tf.weight,
        cross: {
          type: st.type,
          direction: st.dir || null,
          pending: !!st.pending,
          fresh: st.fresh === undefined ? null : !!st.fresh,
          nearing: !!st.nearing,
          watching: !!st.watching,
          barsAgo: st.barsAgo == null ? null : st.barsAgo,
          level,
          zone: level == null ? null : g.zoneOf(st.level),
          k: st.k == null ? null : +st.k.toFixed(2),
          d: st.d == null ? null : +st.d.toFixed(2),
          gap: st.gap == null ? null : +st.gap.toFixed(2),
          side: +g.sideOf(st).toFixed(2),
          /*  Which bar the cross actually printed on. barsAgo answers "how old"
              but changes every time a bar closes, so it cannot identify a
              cross between runs — an unattended watcher needs a stable key or
              it re-reports the same cross every hour it stays fresh.        */
          barOpened: (st.at != null && sr.candles[st.at])
            ? new Date(sr.candles[st.at].t).toISOString() : null,
        },
        ema200: sr.ema && sr.ema.ok
          ? { ok: true, above: sr.ema.above, distancePct: +sr.ema.dist.toFixed(2), value: +sr.ema.v.toFixed(8) }
          : { ok: false, barsAvailable: sr.ema ? sr.ema.bars : null,
              note: 'fewer than 200 bars — a half-seeded EMA is worse than none' },
        divergence: dv ? {
          direction: dv.dir,
          kind: dv.hidden ? 'hidden' : 'regular',
          note: dv.hidden
            ? 'continuation shape: price made a ' + (dv.dir === 'bull' ? 'higher low while %K made a lower low' : 'lower high while %K made a higher high') + ' — not credited by the backtest, which measures regular divergence only'
            : 'reversal shape: price made a ' + (dv.dir === 'bull' ? 'lower low while %K made a higher low' : 'higher high while %K made a lower high'),
          legs: dv.legs + 1,
          settled: !dv.pending,
          barsAgo: dv.barsAgo,
        } : null,
        bar: {
          opened: new Date(sr.openT).toISOString(),
          closes: new Date(sr.closeT).toISOString(),
          live: sr.liveBar >= 0,
          closesIn: sr.liveBar >= 0 ? g.countdown(sr.closeT - now) : null,
          stale: !!sr.behind,
          barsLoaded: sr.candles.length,
        },
        verdict: this._verdict(code, tf.key),
      };
    }

    if (!Object.keys(frames).length)
      throw new Error('no candle data came back for ' + code);

    const closes = g.stoch[code]['1H'] ? g.stoch[code]['1H'].candles : null;
    const best = g.bestTrade(code);

    return {
      symbol: code,
      pair: meta.bybit,
      name: meta.name && meta.name !== code ? meta.name : null,
      market: g.marketLabel(),
      asOf: new Date(now).toISOString(),
      price: closes ? closes[closes.length - 1].c : null,
      bias: this._bias(code),
      btcAlignment: code === g.BTC ? null : this._align(code),
      frames,
      bestSetup: best ? this._verdictShape(best) : null,
      yourTrackRecord: this._trackRecord('stoch', code, closes, now),
      note: 'Stochastic (5,3,3) across ' + g.TFS.map(t => t.key).join('/') +
            '. Verdict grades come from this coin\'s own history on the loaded candles, ' +
            'not from a general rule. Most crosses do not grade well; that is the honest output.',
    };
  }

  _bias(code) {
    const g = this.g;
    const score = g.bias(g.states[code], g.WEIGHTS);
    const label = score >= 50 ? 'strongly bullish'
                : score >= 20 ? 'bullish'
                : score > -20 ? 'mixed'
                : score > -50 ? 'bearish'
                : 'strongly bearish';
    return { score, label, note: 'weighted by timeframe (1M=5 … 1H=1), -100..100' };
  }

  _align(code) {
    const g = this.g;
    const a = g.alignBtc(g.states[code]);
    return { pct: a.pct, framesAgreeing: a.agree, framesClashing: a.clash, framesCompared: a.n };
  }

  _verdict(code, frameKey) {
    return this._verdictShape(this.g.assessTrade(code, frameKey));
  }

  /*  assessTrade already returns the shape the app shows. Passed through
      almost whole — renaming its fields here would be a second vocabulary
      for the same thing.                                                   */
  _verdictShape(v) {
    if (!v) return null;
    const out = {
      frame: v.frame,
      grade: v.grade,
      score: v.score == null ? null : v.score,
      summary: v.summary,
    };
    if (v.grade === 'no signal') return out;
    Object.assign(out, {
      direction: v.direction || null,
      zone: v.zone || null,
      level: v.level == null ? null : v.level,
      settled: v.settled == null ? null : v.settled,
      barsAgo: v.barsAgo == null ? null : v.barsAgo,
      signals: v.signals == null ? null : v.signals,
      thinSample: !!v.thinSample,
      hitRate: v.hitRate || null,
      medianMove: v.medianMove || null,
      beatsOrdinaryCross: v.beatsOrdinaryCross == null ? null : v.beatsOrdinaryCross,
      horizonSpan: v.span || null,
      byHorizon: v.byHorizon || null,
      divergence: v.divergence || null,
      btc: v.btc || null,
      ema200: v.ema200 || null,
      reasons: v.reasons || [],
      warnings: v.warnings || [],
    });
    return out;
  }

  async _loadSymbol(code) {
    const g = this.g;
    const meta = g.symbolOf(code);
    const res = await Promise.all(g.TFS.map(tf => g.pull(meta, tf, g.BARS)));
    g.data[code] = g.data[code] || {};
    g.TFS.forEach((tf, i) => { g.data[code][tf.key] = g.mergeCandles(g.data[code][tf.key], res[i]); });
    g.analyse(code);
  }

  /* ---------- news / structure ---------- */

  /* ---------- the positioning read: get_crowd_snapshot ---------- */

  async crowdSnapshot(symbol, opts) {
    const o = opts || {};
    await this.ready();
    const code = String(symbol || '').trim().toUpperCase().replace(/USDT$/, '');
    if (!code) throw new Error('a symbol is required');

    const cached = this._crowd.get(code);
    if (!o.force && cached && Date.now() - cached.at < this.cacheMs) return cached.value;
    if (cached && cached.promise) return cached.promise;

    const promise = this._crowdSnapshot(code).then(
      value => { this._crowd.set(code, { at: Date.now(), value }); return value; },
      err => { this._crowd.delete(code); throw err; }
    );
    this._crowd.set(code, { at: Date.now(), promise });
    return promise;
  }

  /*  The Crowd terminal's fetch and read (js/ui-crowd.js's crowdTermFetch),
      done here with the same functions from js/crowd.js: the last week of
      hourly open interest, the share of accounts long, the last 30 funding
      settlements and the hourly closes, folded into the metrics the Crowd
      sweep scores and the read recomputed at every hour of the week. It
      knows nothing about the stochastic, the backtest, headlines or the
      web — positioning is a third pair of eyes, not a summary of the other
      two. A positioning series Bybit refuses (the account ratio for a USDC
      perpetual, say) is a named gap, not a failure.                     */
  async _crowdSnapshot(code) {
    const g = this.g;
    await this._universeOnce();
    const meta = g.symbolOf(code);
    const HOURS = 168, LOOK = 24;
    const n = HOURS + LOOK + 1;
    const soft = (q, what) => g.bybit(q).catch(e => ({ list: [], missing: what + ': ' + e.message }));
    const [tk, oiRes, rRes, fRes, kRes] = await Promise.all([
      g.bybit('/tickers?category=linear&symbol=' + meta.bybit),
      soft('/open-interest?category=linear&symbol=' + meta.bybit + '&intervalTime=1h&limit=' + n, 'open interest'),
      soft('/account-ratio?category=linear&symbol=' + meta.bybit + '&period=1h&limit=' + n, 'long/short ratio'),
      soft('/funding/history?category=linear&symbol=' + meta.bybit + '&limit=30', 'funding'),
      g.bybit('/kline?category=linear&symbol=' + meta.bybit + '&interval=60&limit=' + n),
    ]);
    const missing = [oiRes, rRes, fRes].map(x => x.missing).filter(Boolean);
    const tr = (tk.list || [])[0] || {};
    if (!tr.symbol) throw new Error('Bybit has no linear ticker for ' + meta.bybit);
    const kl = (kRes.list || []).map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).sort((a, b) => a.t - b.t);
    if (kl.length < 26) throw new Error('not enough hourly history for ' + code);
    // the 24h move measured off the closes, the way the sweep and the series measure it;
    // the ticker's own figure is only the fallback when there is not a day of bars
    const c24 = kl.length > 24 && kl[kl.length - 25].c > 0 ? (kl[kl.length - 1].c - kl[kl.length - 25].c) / kl[kl.length - 25].c * 100 : (+tr.price24hPcnt) * 100;
    const t = {
      sym: code, bybit: meta.bybit, name: meta.name,
      price: +tr.lastPrice, chg: c24, turnover: +tr.turnover24h,
      funding: +tr.fundingRate, oiVal: +tr.openInterestValue, oi: +tr.openInterest,
      nextFunding: +tr.nextFundingTime || null, hi: +tr.highPrice24h, lo: +tr.lowPrice24h,
    };
    const floorH = x => Math.floor(x / 3600e3) * 3600e3;
    const oi = (oiRes.list || []).map(x => ({ t: floorH(+x.timestamp), oi: +x.openInterest })).filter(x => x.oi > 0).sort((a, b) => a.t - b.t);
    const ratio = (rRes.list || []).map(x => ({ t: floorH(+x.timestamp), buy: +x.buyRatio })).filter(x => isFinite(x.buy)).sort((a, b) => a.t - b.t);
    const fund = (fRes.list || []).map(x => ({ t: +x.fundingRateTimestamp, r: +x.fundingRate })).filter(x => isFinite(x.r)).sort((a, b) => a.t - b.t);

    const m = g.crowdMetrics(t, oi, ratio, fund.map(f => f.r), kl);
    const read = g.crowdScore(m);
    const series = g.crowdSeries(t, kl, oi, ratio, fund);
    const tally = g.crowdSeriesTally(series, 24);
    const flow = g.nvFlow(m.chg24, m.oiChg24);
    const fr = g.crowdFundingRead(m.fundingPct), rr = g.crowdRatioRead(m.ratio);
    const round = (v, d) => v == null || !isFinite(v) ? null : +v.toFixed(d == null ? 2 : d);
    const C = g.CROWD;

    // the last 48 hours, one compact row per hour, so the analyst can see the path and not just the endpoint
    const oiAt = new Map(oi.map(x => [x.t, x.oi])), rAt = new Map(ratio.map(x => [x.t, x.buy]));
    const recent = kl.slice(-48).map(b => ({
      t: new Date(b.t).toISOString().slice(0, 16) + 'Z', close: b.c,
      oi: oiAt.has(b.t) ? oiAt.get(b.t) : null,
      longPct: rAt.has(b.t) ? round(rAt.get(b.t) * 100, 1) : null,
    }));
    const week = series.slice(-HOURS);
    const readsThisWeek = week.filter(s => s.read).map(s => ({
      t: new Date(s.t).toISOString().slice(0, 13) + 'Z', tag: s.read.tag, dir: s.read.dir, score: s.read.score,
      graded: s.grade || 'open', laterPct: s.later == null ? null : round(s.later, 2),
    }));
    // collapse consecutive hours of the same read into episodes — one crowd, not 24 calls
    const episodes = [];
    for (const r of readsThisWeek) {
      const last = episodes[episodes.length - 1];
      if (last && last.tag === r.tag && last.dir === r.dir) { last.hours++; last.to = r.t; last.right += r.graded === 'right' ? 1 : 0; last.wrong += r.graded === 'wrong' ? 1 : 0; last.open += r.graded === 'open' ? 1 : 0; }
      else episodes.push({ tag: r.tag, dir: r.dir, from: r.t, to: r.t, hours: 1, right: r.graded === 'right' ? 1 : 0, wrong: r.graded === 'wrong' ? 1 : 0, open: r.graded === 'open' ? 1 : 0 });
    }

    const out = {
      symbol: code, name: meta.name || code, pair: meta.bybit, asOf: new Date().toISOString(),
      note: 'Positioning only: funding, open interest, the share of accounts long, and price over the last week. ' +
            'This tool knows nothing about the stochastic, crosses, backtests, headlines or the web, and it will not guess at them.',
      price: t.price, change24hPct: round(t.chg), high24h: t.hi, low24h: t.lo, turnover24hUsd: Math.round(t.turnover),
      funding: {
        nowPctPer8h: round(m.fundingPct, 4), avgLast8Pct: round(m.fundAvgPct, 4),
        annualisedPct: m.fundingPct == null ? null : Math.round(m.fundingPct * 3 * 365),
        nextSettlementAt: t.nextFunding ? new Date(t.nextFunding).toISOString() : null,
        read: fr.side ? (fr.level === 2 ? 'extreme' : 'crowded') + ' — ' + fr.side + 's paying' : 'normal',
        thresholds: { crowdedLongPct: C.fundLong, extremeLongPct: C.fundLongX, crowdedShortPct: C.fundShort, extremeShortPct: C.fundShortX },
        history: fund.slice(-30).map(f => ({ t: new Date(f.t).toISOString().slice(0, 13) + 'Z', pctPer8h: round(f.r * 100, 4) })),
      },
      openInterest: {
        valueUsd: isFinite(t.oiVal) ? Math.round(t.oiVal) : null, contracts: isFinite(t.oi) ? t.oi : null,
        change4hPct: round(m.oiChg4), change24hPct: round(m.oiChg24),
        change7dPct: oi.length > 168 ? round((oi[oi.length - 1].oi - oi[oi.length - 169].oi) / oi[oi.length - 169].oi * 100) : null,
        toTurnover: round(m.oiToTurnover), overhang: m.oiToTurnover != null && m.oiToTurnover >= C.overhang,
        note: 'OI value / 24h turnover past ' + C.overhang + ' is an overhang: open positions are large against the daily flow, so a move that unwinds them gets sharp.',
      },
      accounts: {
        longPct: m.ratio == null ? null : round(m.ratio * 100, 1), avg24hPct: m.ratioAvg == null ? null : round(m.ratioAvg * 100, 1),
        read: rr.side ? (rr.level === 2 ? 'extreme' : 'heavy') + ' ' + rr.side : 'balanced',
        thresholds: { heavyLongPct: C.ratioLong * 100, extremeLongPct: C.ratioLongX * 100, heavyShortPct: C.ratioShort * 100, extremeShortPct: C.ratioShortX * 100 },
        note: 'Share of Bybit accounts net long in this contract. Alts rest long-biased, so heavy long starts above ' + C.ratioLong * 100 + '%, not 50%.',
      },
      flow: { tag: flow.tag, why: flow.why },
      read: read ? { tag: read.tag, direction: read.dir, score: read.score, kind: read.kind, crowdedSide: read.crowd || null, why: read.why }
                 : { tag: null, direction: null, score: 0, kind: null, crowdedSide: null,
                     why: ['Nothing here is crowded, fresh, squeezed or coiled — a read needs ' + g.CROWD_MIN_SCORE + ' points and nothing earns them right now.'] },
      lastWeek: {
        hoursWithARead: tally.n, of: week.length, right24h: tally.right, wrong24h: tally.wrong, flat24h: tally.flat, stillOpen: tally.open,
        rateOfDecidedPct: tally.rate, byKind: tally.byKind, episodes,
        note: 'The same read recomputed at every hour of the last week and graded on where price was 24h later (±0.5% is flat). Hours overlap — a crowd that lasts a day is one crowd, not 24 calls — so this is the coin\'s recent character, not a sample.',
      },
      last48h: recent,
      missing: missing.length ? missing : null,
    };
    out.yourTrackRecord = this._trackRecord('crowd', code, null, Date.now());
    return out;
  }

  async newsSnapshot(symbol, opts) {
    const o = opts || {};
    await this.ready();
    const code = String(symbol || '').trim().toUpperCase().replace(/USDT$/, '');
    if (!code) throw new Error('a symbol is required');
    const win = String(o.window || '24h').toLowerCase();
    if (!WINDOWS.includes(win))
      throw new Error('window must be one of ' + WINDOWS.join(', ') + ', got ' + win);

    const board = await this._boardSweep(!!o.force);
    return this._newsSnapshot(code, win, board, o.headlines !== false);
  }

  /*  One sweep of the liquid board, shared by every coin asked about inside the
      cache window. This is newsScan()'s measuring loop with the DOM, the Stop
      button, the top-twenty filter and the anomaly log taken out; every value
      in it is still computed by the app's own functions.                    */
  async _boardSweep(force) {
    if (!force && this._board && this._board.value && Date.now() - this._board.at < this.cacheMs)
      return this._board.value;
    if (this._board && this._board.promise) return this._board.promise;

    const promise = this._sweep().then(
      value => { this._board = { at: Date.now(), value }; return value; },
      err => { this._board = null; throw err; }
    );
    this._board = { at: Date.now(), promise };
    return promise;
  }

  async _sweep() {
    const g = this.g;
    const all = await g.newsBoard();
    const liquid = all.filter(t => t.turnover >= this.minLiq * 1e6);
    if (!liquid.length)
      throw new Error('nothing on the board clears a $' + this.minLiq + 'm book');

    const cands = liquid.slice(0, this.boardWidth);
    const H1 = g.TFS.find(t => t.key === '1H');

    const measured = (await g.nvPool(cands, 6, async t => {
      const candles = await g.pull({ bybit: t.bybit }, H1, 26);
      if (!candles || candles.length < 6) return null;
      return Object.assign({}, t, {
        m:     { '1h': g.nvPctOver(candles, 1),  '4h': g.nvPctOver(candles, 4),  '24h': g.nvPctOver(candles, 24) },
        sharp: { '1h': g.nvSharpest(candles, 1), '4h': g.nvSharpest(candles, 4), '24h': g.nvSharpest(candles, 24) },
        hourlyVol: g.nvMedian(candles.slice(-24).map(c => c.v)),
      });
    })).filter(Boolean);

    if (!measured.length) throw new Error('no candle history came back for the board');

    const medians = {};
    for (const w of WINDOWS)
      medians[w] = g.nvMedian(measured.map(r => r.m[w]).filter(v => v != null && isFinite(v)));

    return { at: Date.now(), all, liquid, measured, medians };
  }

  async _newsSnapshot(code, win, board, wantHeadlines) {
    const g = this.g;
    // nvOpenInterest reads its lookback off newsCfg — set it before asking.
    this.g.newsCfg.win = win;

    const onBoard = board.all.find(t => t.sym === code) || null;
    const rank = onBoard ? board.all.indexOf(onBoard) + 1 : null;
    const thinBook = !!onBoard && onBoard.turnover < this.minLiq * 1e6;
    let row = board.measured.find(r => r.sym === code) || null;
    let measuredDirectly = false;

    /*  A coin can be off the top-90 slice, below the liquidity floor, or not on
        the perpetual board at all. None of those is an error — it is a fact
        about the coin, and the analyst needs to be told it rather than handed
        a failure. So it gets measured on its own, the same way, and flagged. */
    if (!row) {
      const meta = g.symbolOf(code);
      const H1 = g.TFS.find(t => t.key === '1H');
      const candles = await g.pull({ bybit: meta.bybit }, H1, 26);
      if (!candles || candles.length < 6)
        throw new Error('not enough hourly history for ' + code);
      row = Object.assign({
        sym: code, bybit: meta.bybit,
        price: candles[candles.length - 1].c,
        turnover: onBoard ? onBoard.turnover : null,
        funding: onBoard ? onBoard.funding : null,
        oiVal: onBoard ? onBoard.oiVal : null,
      }, {
        m:     { '1h': g.nvPctOver(candles, 1),  '4h': g.nvPctOver(candles, 4),  '24h': g.nvPctOver(candles, 24) },
        sharp: { '1h': g.nvSharpest(candles, 1), '4h': g.nvSharpest(candles, 4), '24h': g.nvSharpest(candles, 24) },
        hourlyVol: g.nvMedian(candles.slice(-24).map(c => c.v)),
      });
      measuredDirectly = true;
    }

    const move = row.m[win];
    if (move == null || !isFinite(move))
      throw new Error('no ' + win + ' move could be measured for ' + code);

    const med = board.medians[win];
    const sharp = row.sharp[win];

    // The same row shape recomputeNews() builds, so nvStructural reads it whole.
    const r = Object.assign({}, row, {
      move,
      excess: move - med,
      share: move ? med / move : 0,
      kind: g.nvKind(move, med),
      sharp,
      volX: (sharp && row.hourlyVol) ? sharp.v / row.hourlyVol : null,
    });

    let oi = null;
    try { oi = await g.nvOpenInterest(r); } catch (e) { oi = null; }
    r.oi = oi;
    r.flow = g.nvFlow(r.move, oi ? oi.chg : null);

    let name = null;
    try { await g.nvLoadCoins(); name = g.nvCoinName(code, null) || null; } catch (e) { /* offline */ }
    r.coinName = name;

    const structural = g.nvStructural(r);

    const out = {
      symbol: code,
      pair: r.bybit,
      name,
      market: g.marketLabel(),
      window: win,
      asOf: new Date().toISOString(),
      price: r.price == null ? null : r.price,
      liquidity: {
        turnover24hUsd: r.turnover == null ? null : Math.round(r.turnover),
        boardRank: rank,
        onBoard: !!onBoard,
        offBoard: !onBoard,
        thinBook,
        measuredOutsideSweep: measuredDirectly,
        floorUsd: this.minLiq * 1e6,
        caveat: !onBoard
          ? code + ' is not on the ' + g.marketLabel() + ' board at all — it was measured from its own candles. Treat the board comparison as indicative.'
          : thinBook
          ? code + ' trades under the $' + this.minLiq + 'm turnover floor. A large percentage move on a thin book is not the same event as one on a deep book.'
          : measuredDirectly
          ? code + ' is liquid but sits outside the top ' + this.boardWidth + ' books, so it was measured on its own against the same board median.'
          : null,
      },
      move: {
        pct: +move.toFixed(2),
        boardMedianPct: +med.toFixed(2),
        excessPct: +r.excess.toFixed(2),
        boardShare: +r.share.toFixed(3),
        classification: r.kind,
        classificationLabel: { mkt: 'market-wide', part: 'amplified market move', spec: 'coin-specific' }[r.kind],
      },
      sharpestHour: sharp ? {
        at: new Date(sharp.t).toISOString(),
        pct: +sharp.pct.toFixed(2),
        volume: sharp.v,
        volumeMultiple: r.volX == null ? null : +r.volX.toFixed(2),
      } : null,
      positioning: {
        openInterestChangePct: oi ? +oi.chg.toFixed(2) : null,
        openInterestNow: oi ? oi.now : null,
        flow: r.flow ? { tag: r.flow.tag, why: r.flow.why, side: r.flow.cls } : null,
        fundingRatePct8h: isFinite(r.funding) && r.funding != null ? +(r.funding * 100).toFixed(4) : null,
        fundingCrowded: isFinite(r.funding) && r.funding != null ? Math.abs(r.funding * 100) > 0.05 : null,
      },
      structuralRead: structural,
      board: {
        symbolsOnBoard: board.all.length,
        symbolsMeasured: board.measured.length,
        medianPct: +med.toFixed(2),
        btcPct: (() => {
          const b = board.measured.find(x => x.sym === 'BTC');
          return b && b.m[win] != null ? +b.m[win].toFixed(2) : null;
        })(),
        sweptAt: new Date(board.at).toISOString(),
      },
      headlines: [],
      headlineNote: null,
    };

    if (wantHeadlines) Object.assign(out, await this._headlines(r, code, name));
    else out.headlineNote = 'headlines were not requested';

    out.yourTrackRecord = this._trackRecord('news', code, null, Date.now());
    return out;
  }

  /*  One analyst's own record, in its own snapshot — and only its own. The
      stoch tool reads the stoch file, the news tool the news file, and the
      two processes never hold the other's. Read off disk on every snapshot
      (small file, and the snapshot is cached anyway) so a checkpoint that
      settled an hour ago is in the next brief without anyone re-briefing.
      Never a reason for the read to fail: an unreadable record is "no
      record", not an error.                                              */
  _trackRecord(side, code, bars, now) {
    try {
      const { readTrack, scoreBrief } = require('./score.js');
      return scoreBrief(readTrack(side, this.verdictsDir), { symbol: code, bars, now });
    } catch (e) {
      return { error: 'the track record could not be read: ' + e.message, text: 'You have no track record available for this read.' };
    }
  }

  async _headlines(r, code, name) {
    const g = this.g;
    try {
      const [feed, coinFeed] = await Promise.all([
        g.nvHeadlines(),
        g.nvCoinHeadlines(code, name),
      ]);
      const matched = g.nvMatchNews(r, (feed || []).concat(coinFeed || []));
      return {
        headlines: matched.map(n => ({
          source: n.src,
          title: n.title,
          url: n.url || null,
          publishedAt: new Date(n.t).toISOString(),
          lagHours: +n.lag.toFixed(2),
          relationToMove: n.lag >= -0.5 ? 'before the move' : 'after the move',
          label: g.nvLagLabel(n.lag),
          exchangeAnnouncement: !!n.exch,
          matchScore: n.score,
        })),
        headlineSources: g.newsFeedSrcs || [],
        headlineNote: matched.length ? null :
          'No headline in the last day or two names ' + code + (name ? ' or ' + name : '') +
          '. Read that as thin coverage, not as "nothing happened" — below BTC/ETH the ' +
          'cause is more often an exchange listing elsewhere, an unlock, or a squeeze ' +
          'than anything a desk writes up.',
      };
    } catch (e) {
      return {
        headlines: [],
        headlineSources: [],
        headlineNote: 'the headline layer could not be reached (' + e.message +
                      '). The structural read above comes from exchange data and still stands.',
      };
    }
  }
}

module.exports = { Engine, APP_FILES, WINDOWS, makeFetch };

/* mcp.test.js — the MCP engine and server, against the committed fake exchange.

   Two things are being proved here, and the second matters more than the first:

     1. the tools answer, in the shape an analyst is promised, for every board
        case — a big coin-specific move, an ordinary one, a book under the
        liquidity floor, and a coin that is not on the board at all;

     2. the engine is running the APP'S maths, not a copy of it. The check that
        earns its keep is the one that recomputes the stochastic straight out of
        js/indicators.js on the same candles and demands the same %K and %D the
        engine reported. If someone ever reimplements the maths inside mcp/,
        that check is what fails.
   part of Odysseus */

const path = require('path');
const { load } = require('./harness');

const MCP = path.join(__dirname, '..', 'mcp');
const { start: startFake } = require(path.join(MCP, 'test', 'fakebybit.js'));
const { Engine } = require(path.join(MCP, 'engine.js'));
const { buildServer } = require(path.join(MCP, 'server.js'));
const { serveHttp } = require(path.join(MCP, 'protocol.js'));
const { connectHttp, connectStdio } = require(path.join(MCP, 'client.js'));

const GRADES = ['strong', 'playable', 'thin', 'no edge', 'negative', 'untested', 'no signal'];

later(async () => {
  const fake = await startFake();
  const engine = new Engine({ hostMap: fake.hostMap, cacheMs: 600000 });

  try {
    /* ---------------------------------------------------------------- */
    suite('mcp/engine — stochastic snapshot');

    const sol = await engine.stochSnapshot('SOL');

    check('reports the symbol it was asked about', sol.symbol, 'SOL');
    check('resolves the Bybit pair', sol.pair, 'SOLUSDT');
    check('names the venue', sol.market, 'Bybit perpetual');
    check('covers every timeframe', Object.keys(sol.frames).sort(), ['1D', '1H', '1M', '1W', '4H']);
    ok('carries a price', typeof sol.price === 'number' && sol.price > 0);
    ok('bias is a -100..100 score', sol.bias.score >= -100 && sol.bias.score <= 100);
    ok('an alt is compared against BTC', sol.btcAlignment && sol.btcAlignment.framesCompared > 0);

    const d1 = sol.frames['1D'];
    ok('a frame carries a cross type', typeof d1.cross.type === 'string');
    ok('%K is a percentage', d1.cross.k >= 0 && d1.cross.k <= 100);
    ok('%D is a percentage', d1.cross.d >= 0 && d1.cross.d <= 100);
    const zoneFor = v => v <= 20 ? 'oversold' : v < 80 ? 'middle' : 'overbought';
    ok('the zone matches the level',
       d1.cross.level == null || d1.cross.zone === zoneFor(d1.cross.level));
    ok('the daily bar is live and counting down', d1.bar.live === true && typeof d1.bar.closesIn === 'string');
    ok('the daily has enough history for the 200 EMA', d1.ema200.ok === true);
    ok('the monthly does not pretend to have one', sol.frames['1M'].ema200.ok === false);

    ok('every frame carries a verdict grade', Object.values(sol.frames)
       .every(f => GRADES.includes(f.verdict.grade)));

    const graded = Object.values(sol.frames).find(f => f.verdict.byHorizon);
    ok('a graded frame breaks out by horizon', !!graded);
    if (graded) {
      const rows = Object.values(graded.verdict.byHorizon).filter(Boolean);
      check('four horizons are reported', Object.keys(graded.verdict.byHorizon).length, 4);
      ok('each horizon carries hit rate, median and sample size',
         rows.every(r => /^\d+%$/.test(r.hit) && /%$/.test(r.median) && typeof r.samples === 'number'));
      ok('hit rate is a percentage string', /^\d+%$/.test(graded.verdict.hitRate));
      ok('the summary names the grade', graded.verdict.summary.includes(graded.verdict.grade.toUpperCase()));
    }

    /*  The record holds a veto: confluence may improve a setup that works, and
        may never rescue one that does not. A frame whose history is a losing
        one must not grade above "no edge" no matter what else agrees.       */
    const vetoed = Object.values(sol.frames).filter(f =>
      f.verdict.hitRate && parseInt(f.verdict.hitRate, 10) < 50);
    ok('a sub-50% record cannot grade better than "no edge"',
       vetoed.every(f => f.verdict.grade === 'no edge' || f.verdict.grade === 'negative'));

    /* ---------------------------------------------------------------- */
    suite('mcp/engine — it is the app\'s own maths, not a copy');

    /*  Pull the same candles the engine pulled, straight off the fake, and run
        js/indicators.js over them in a plain harness context. If mcp/ ever
        grows its own stochastic, these stop matching.                       */
    const res = await fetch(fake.url + '/v5/market/kline?category=linear&symbol=SOLUSDT&interval=60&limit=1000');
    const raw = (await res.json()).result.list
      .map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }))
      .reverse();

    const appOnly = load(['indicators.js']);
    const s = appOnly.stochastic(raw.map(c => c.h), raw.map(c => c.l), raw.map(c => c.c), 5, 3, 3);
    const last = s.k.length - 1;

    near('%K matches js/indicators.js exactly', sol.frames['1H'].cross.k, +s.k[last].toFixed(2), 0.005);
    near('%D matches js/indicators.js exactly', sol.frames['1H'].cross.d, +s.d[last].toFixed(2), 0.005);

    const st = appOnly.crossState(s.k, s.d, 4, last);
    check('the cross type matches js/indicators.js', sol.frames['1H'].cross.type, st.type);

    /* ---------------------------------------------------------------- */
    suite('mcp/engine — news snapshot');

    const sq = await engine.newsSnapshot('SQUEZ', { window: '24h' });

    near('the 24h move is measured close to close', sq.move.pct, 28, 0.02);
    check('a move far beyond the board is coin-specific', sq.move.classification, 'spec');
    check('and is labelled in words', sq.move.classificationLabel, 'coin-specific');
    ok('the excess over the board is carried', sq.move.excessPct > 20);
    ok('the sharpest hour is found', sq.sharpestHour && sq.sharpestHour.pct > 10);
    ok('and its volume multiple flags the spike', sq.sharpestHour.volumeMultiple > 3);
    check('falling OI on a rising price reads as a squeeze', sq.positioning.flow.tag, 'Short squeeze');
    check('the squeeze is a long-side event', sq.positioning.flow.side, 'long');
    ok('crowded funding is flagged', sq.positioning.fundingCrowded === true);
    ok('the structural read is a sentence, not a number dump',
       sq.structuralRead.includes('beyond the board') && sq.structuralRead.includes('Short squeeze'));
    ok('a liquid board coin carries no caveat', sq.liquidity.caveat === null);
    ok('the coin name is resolved for searching', sq.name === 'Squeezer');

    ok('a headline naming the coin is matched', sq.headlines.length > 0);
    ok('a catalyst published first is labelled as before the move',
       sq.headlines.some(h => h.relationToMove === 'before the move'));
    ok('an exchange listing is recognised as one',
       sq.headlines.some(h => h.exchangeAnnouncement === true));

    /* ---------------------------------------------------------------- */
    suite('mcp/engine — crowd snapshot: positioning, and nothing else');

    const cs = await engine.crowdSnapshot('SQUEZ');
    check('it names the coin and the pair', [cs.symbol, cs.pair], ['SQUEZ', 'SQUEZUSDT']);
    ok('funding is quoted per 8h and annualised', cs.funding.nowPctPer8h > 0.08 && cs.funding.annualisedPct > 90);
    check('0.09%/8h is crowded, longs paying (extreme starts at 0.10)', cs.funding.read, 'crowded — longs paying');
    ok('the funding history came through', cs.funding.history.length === 30);
    ok('open interest fell against a rising price', cs.openInterest.change24hPct < -10);
    check('so the flow is a short squeeze', cs.flow.tag, 'Short squeeze');
    ok('the share of accounts long is a percentage', cs.accounts.longPct > 50 && cs.accounts.longPct < 100);
    ok('the app\'s own read is carried with its reasons', cs.read && Array.isArray(cs.read.why) && cs.read.why.length > 0);
    ok('and it is the same read js/crowd.js would give from the same metrics',
       (() => { const g = engine.g; const m = { chg24: cs.change24hPct, chg4: null, fundingPct: cs.funding.nowPctPer8h, fundAvgPct: cs.funding.avgLast8Pct,
                ratio: cs.accounts.longPct / 100, ratioAvg: cs.accounts.avg24hPct / 100, oiChg24: cs.openInterest.change24hPct, oiChg4: cs.openInterest.change4hPct,
                oiToTurnover: cs.openInterest.toTurnover, turnover: cs.turnover24hUsd }; const r = g.crowdScore(m); return !!r && r.tag === cs.read.tag && r.dir === cs.read.direction; })());
    ok('the last 48 hours are there, hour by hour', cs.last48h.length === 48 && cs.last48h.every(h => typeof h.close === 'number'));
    ok('the week is summarised as episodes, not 168 calls', Array.isArray(cs.lastWeek.episodes) && cs.lastWeek.of > 100);
    check('nothing was missing on a coin the fake serves fully', cs.missing, null);
    ok('the tool disclaims the other sides', /knows nothing about the stochastic/.test(cs.note));
    ok('it carries this analyst\'s own record and no other', cs.yourTrackRecord && !('stoch' in cs) && !('frames' in cs) && !('headlines' in cs));
    ok('a second call inside the cache window is the same object', (await engine.crowdSnapshot('SQUEZ')) === cs);

    const ord = await engine.newsSnapshot('ORDIN', { window: '24h' });
    check('a move the board partly explains is amplified, not coin-specific', ord.move.classification, 'part');
    check('rising OI on a rising price is fresh money', ord.positioning.flow.tag, 'New longs');
    ok('no headline names it, and the tool says why that is not proof of nothing',
       ord.headlines.length === 0 && ord.headlineNote.includes('thin coverage'));

    const thin = await engine.newsSnapshot('THINB', { window: '24h' });
    ok('a book under the floor is flagged rather than refused', thin.liquidity.thinBook === true);
    ok('and the caveat says why that matters', thin.liquidity.caveat.includes('thin book'));
    near('it is still measured properly', thin.move.pct, 19.5, 0.02);

    const off = await engine.newsSnapshot('OFFBD', { window: '24h' });
    ok('a coin absent from the board still answers', off.move.pct != null);
    ok('and is flagged as off-board', off.liquidity.offBoard === true && off.liquidity.onBoard === false);
    ok('with the comparison marked indicative', off.liquidity.caveat.includes('not on the'));

    const short = await engine.newsSnapshot('SQUEZ', { window: '1h' });
    check('the window is honoured', short.window, '1h');
    ok('a shorter window gives a different move', short.move.pct !== sq.move.pct);

    const bare = await engine.newsSnapshot('SQUEZ', { window: '24h', headlines: false });
    check('headlines can be switched off', bare.headlines.length, 0);
    ok('and the exchange-only read still stands', bare.structuralRead.length > 40);

    let rejected = false;
    try { await engine.newsSnapshot('SQUEZ', { window: '12h' }); } catch (e) { rejected = /window must be/.test(e.message); }
    ok('an unknown window is refused with a useful message', rejected);

    /* ---------------------------------------------------------------- */
    suite('mcp/engine — each snapshot carries its own track record, and only its own');
    {
      const fs = require('fs'), os = require('os');
      const { writeTrack } = require(path.join(MCP, 'score.js'));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odysseus-track-'));
      const at = new Date(Date.now() - 30 * 3600e3).toISOString();
      writeTrack('stoch', [{ id: 'a', symbol: 'SOL', generatedAt: at, call: 'bull', conviction: 66, setup: '4H bull',
                             claim: 'stoch said so', checks: { '24': { pct: 2.1, grade: 'right', entry: 100, exit: 102.1 } } }], dir);
      writeTrack('news',  [{ id: 'a', symbol: 'SQUEZ', generatedAt: at, call: 'bear', conviction: 44, setup: 'spec, no catalyst',
                             claim: 'news said so', checks: { '24': { pct: 3, grade: 'wrong', entry: 100, exit: 103 } } }], dir);
      const own = new Engine({ hostMap: fake.hostMap, cacheMs: 600000, verdictsDir: dir });

      const ss = await own.stochSnapshot('SOL');
      ok('the stoch snapshot carries a track record', ss.yourTrackRecord && typeof ss.yourTrackRecord.text === 'string');
      check('it is the stoch record — this coin\'s last call is the stoch one', ss.yourTrackRecord.onThisCoin.lastCall.claim, 'stoch said so');
      ok('and nothing from the news file is in it', !JSON.stringify(ss.yourTrackRecord).includes('news said so'));

      const ns = await own.newsSnapshot('SQUEZ', { window: '24h', headlines: false });
      ok('the news snapshot carries a track record', ns.yourTrackRecord && typeof ns.yourTrackRecord.text === 'string');
      check('it is the news record', ns.yourTrackRecord.onThisCoin.lastCall.claim, 'news said so');
      ok('and nothing from the stoch file is in it', !JSON.stringify(ns.yourTrackRecord).includes('stoch said so'));
      ok('the miss is there for the analyst to read, with the shape withheld when no excursion was kept',
         ns.yourTrackRecord.recentMisses.length === 1 && ns.yourTrackRecord.recentMisses[0].shape === null);

      const none = new Engine({ hostMap: fake.hostMap, cacheMs: 600000, verdictsDir: path.join(dir, 'empty') });
      const es = await none.stochSnapshot('SOL');
      check('no record files at all is "no track record", not a failed read', es.yourTrackRecord.text, 'You have no track record yet.');
      fs.rmSync(dir, { recursive: true, force: true });
    }

    /* ---------------------------------------------------------------- */
    suite('mcp/engine — watchlist and identity');

    const wl = engine.watchlist();
    ok('a watchlist comes back', wl.symbols.length > 0);
    ok('it says where it came from', typeof wl.source === 'string' && wl.source.length > 0);

    process.env.ODYSSEUS_WATCHLIST = 'sol, squez ,ordin';
    const envWl = new Engine({ hostMap: fake.hostMap }).watchlist();
    check('the env var wins, upper-cased and trimmed', envWl.symbols, ['SOL', 'SQUEZ', 'ORDIN']);
    check('and says so', envWl.source, 'ODYSSEUS_WATCHLIST');
    delete process.env.ODYSSEUS_WATCHLIST;

    check('a ticker resolves to its real name', await engine.coinName('SQUEZ'), 'Squeezer');
    check('an unknown ticker resolves to nothing rather than guessing', await engine.coinName('ZZZZZZ'), null);

    /* ---------------------------------------------------------------- */
    suite('mcp/server — the protocol, over HTTP');

    const server = buildServer(engine);
    const live = await serveHttp(server, { port: 0, host: '127.0.0.1', token: 'test-token' });

    let unauthorised = false;
    try {
      const r = await fetch(live.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      unauthorised = r.status === 401;
    } catch (e) { /* fetch itself should not fail */ }
    ok('a bearer token is enforced when one is set', unauthorised);

    const client = await connectHttp(live.url, { token: 'test-token' });

    const tools = await client.listTools();
    check('exactly four tools are exposed', tools.length, 4);
    check('and they are the four, still separate', tools.map(t => t.name).sort(),
          ['get_crowd_snapshot', 'get_news_snapshot', 'get_stoch_snapshot', 'get_watchlist']);
    ok('the crowd tool disclaims the other sides', /knows nothing about the stochastic, crosses, backtests, headlines/.test(
       tools.find(t => t.name === 'get_crowd_snapshot').description));
    ok('every tool declares itself read-only', tools.every(t => t.annotations.readOnlyHint === true));
    ok('and non-destructive', tools.every(t => t.annotations.destructiveHint === false));
    ok('the stochastic tool disclaims news', /knows nothing about news/.test(
       tools.find(t => t.name === 'get_stoch_snapshot').description));
    ok('the news tool disclaims the stochastic', /knows nothing about the stochastic/.test(
       tools.find(t => t.name === 'get_news_snapshot').description));

    const viaTool = await client.callTool('get_stoch_snapshot', { symbol: 'SOL' });
    check('the tool returns the same snapshot the engine does', viaTool.symbol, 'SOL');
    ok('with its frames intact', Object.keys(viaTool.frames).length === 5);

    const newsTool = await client.callTool('get_news_snapshot', { symbol: 'SQUEZ', window: '24h', headlines: false });
    check('the news tool answers for the same coin', newsTool.symbol, 'SQUEZ');
    check('and honours its arguments', newsTool.window, '24h');

    const wlTool = await client.callTool('get_watchlist', {});
    ok('the watchlist tool answers', wlTool.count > 0 && wlTool.symbols.length === wlTool.count);
    ok('and resolves names so an analyst does not search a bare ticker',
       wlTool.symbols.every(s => 'name' in s));

    // argument validation, so a bad call is an argument error and not a stack trace
    let badEnum = null;
    try { await client.callTool('get_news_snapshot', { symbol: 'SOL', window: '12h' }); }
    catch (e) { badEnum = e; }
    ok('an out-of-range enum is rejected', badEnum && /must be one of/.test(badEnum.message));
    check('as an invalid-params error', badEnum && badEnum.code, -32602);

    let missing = null;
    try { await client.callTool('get_stoch_snapshot', {}); } catch (e) { missing = e; }
    ok('a missing required argument is rejected', missing && /is required/.test(missing.message));

    let unknownArg = null;
    try { await client.callTool('get_stoch_snapshot', { symbol: 'SOL', sentiment: true }); }
    catch (e) { unknownArg = e; }
    ok('an argument the tool does not have is rejected', unknownArg && /not a known argument/.test(unknownArg.message));

    let unknownTool = null;
    try { await client.callTool('get_everything', {}); } catch (e) { unknownTool = e; }
    check('an unknown tool is a method-not-found', unknownTool && unknownTool.code, -32601);

    let unknownMethod = null;
    try { await client.request('tools/invent'); } catch (e) { unknownMethod = e; }
    check('so is an unknown method', unknownMethod && unknownMethod.code, -32601);

    check('ping answers', JSON.stringify(await client.ping()), '{}');

    /*  A tool that fails at runtime must come back as a result with isError,
        not as a protocol error — the model needs to read what went wrong.   */
    const bad = await client.callToolRaw('get_stoch_snapshot', { symbol: 'NOSUCH' });
    ok('a failing tool reports isError inside the result', bad.isError === true);
    ok('and says what happened in the text', /not found|no candle|Bybit/i.test(bad.content[0].text));

    await client.close();
    await live.close();

    /* ---------------------------------------------------------------- */
    suite('mcp/server — blindness is enforced by separation, not instruction');

    /*  A real MCP client hands a chat every tool a server offers; there is no
        per-conversation tool picking. So the only way an analyst genuinely
        cannot see the other side's data is for that data not to exist in the
        process it is talking to. These are the checks that the split is real. */

    const stochOnly = buildServer(engine, { tools: 'stoch' });
    const newsOnly = buildServer(engine, { tools: 'news' });

    check('the stoch process is named for what it is', stochOnly.name, 'odysseus-stoch');
    check('and exposes only its own read plus the watchlist',
          stochOnly.listTools().map(t => t.name).sort(), ['get_stoch_snapshot', 'get_watchlist']);
    ok('the news tool is absent from it entirely', !stochOnly.tools.has('get_news_snapshot'));

    check('the news process likewise', newsOnly.listTools().map(t => t.name).sort(),
          ['get_news_snapshot', 'get_watchlist']);
    ok('the stoch tool is absent from it entirely', !newsOnly.tools.has('get_stoch_snapshot'));

    /*  Asking for the other side is a method-not-found, because the tool is not
        there — the same answer you would get for a tool that never existed.  */
    const denied = await stochOnly.handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_news_snapshot', arguments: { symbol: 'SOL' } },
    });
    check('reaching for the other side fails as method-not-found', denied.error.code, -32601);

    const handshake = await stochOnly.handle({
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    ok('and the server tells the analyst its side is the only one it has',
       /INDICATOR side only/.test(handshake.result.instructions));
    ok('the news side says the same in reverse',
       /STRUCTURAL and NEWS side only/.test(
         (await newsOnly.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })).result.instructions));

    check('the default is still everything', buildServer(engine).listTools().length, 4);
    const crowdOnly = buildServer(engine, { tools: 'crowd' });
    check('the crowd set is the crowd tool and the watchlist', crowdOnly.listTools().map(t => t.name).sort(), ['get_crowd_snapshot', 'get_watchlist']);
    ok('and it says so', /POSITIONING side only/.test(
       (await crowdOnly.handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} })).result.instructions));
    check('an explicit list works too',
          buildServer(engine, { tools: 'get_watchlist' }).listTools().map(t => t.name), ['get_watchlist']);

    let badSet = false;
    try { buildServer(engine, { tools: 'sentiment' }); } catch (e) { badSet = /unknown tool/.test(e.message); }
    ok('an unknown tool set is refused with a useful message', badSet);

    /* ---------------------------------------------------------------- */
    suite('mcp/server — the protocol, over stdio');

    const stdio = await connectStdio(process.execPath, [path.join(MCP, 'server.js')], {
      env: {
        ODYSSEUS_HOST_MAP: JSON.stringify(fake.hostMap),
        ODYSSEUS_WATCHLIST: 'SOL,SQUEZ',
      },
      timeoutMs: 120000,
    });

    const stdioTools = await stdio.listTools();
    check('stdio exposes the same four tools', stdioTools.map(t => t.name).sort(),
          ['get_crowd_snapshot', 'get_news_snapshot', 'get_stoch_snapshot', 'get_watchlist']);

    const stdioWl = await stdio.callTool('get_watchlist', { names: false });
    check('and reads the watchlist from the environment', stdioWl.symbols.map(s => s.symbol), ['SOL', 'SQUEZ']);

    const stdioStoch = await stdio.callTool('get_stoch_snapshot', { symbol: 'SQUEZ' });
    check('a real snapshot survives the stdio round trip', stdioStoch.symbol, 'SQUEZ');
    ok('with verdicts attached', Object.values(stdioStoch.frames).every(f => GRADES.includes(f.verdict.grade)));

    await stdio.close();
  } finally {
    await fake.close();
  }
});

suite('mcp/engine — the watchlist file: scope and exclude');
later(async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { Engine } = require(path.join(__dirname, '..', 'mcp', 'engine.js'));
  const tmp = path.join(os.tmpdir(), 'odysseus-wl-' + process.pid + '.json');
  const saved = process.env.ODYSSEUS_WATCHLIST;
  delete process.env.ODYSSEUS_WATCHLIST;

  fs.writeFileSync(tmp, JSON.stringify({ scope: 'board', symbols: ['sol', 'BTC'], exclude: ['aapl', 'XAU'] }));
  let wl = new Engine({ watchlistPath: tmp }).watchlist();
  check('scope is read from the file', wl.scope, 'board');
  check('symbols are upper-cased', wl.symbols, ['SOL', 'BTC']);
  check('so is the exclude list', wl.exclude, ['AAPL', 'XAU']);
  check('no always list means the watcher decides', wl.always, null);

  fs.writeFileSync(tmp, JSON.stringify({ scope: 'board', symbols: ['SOL'], always: ['btc', 'eth'] }));
  wl = new Engine({ watchlistPath: tmp }).watchlist();
  check('an always list is read, upper-cased', wl.always, ['BTC', 'ETH']);

  fs.writeFileSync(tmp, JSON.stringify(['eth']));
  wl = new Engine({ watchlistPath: tmp }).watchlist();
  check('a bare array is a plain watchlist', [wl.scope, wl.symbols, wl.exclude], ['watchlist', ['ETH'], []]);

  fs.writeFileSync(tmp, JSON.stringify({ scope: 'board', symbols: ['SOL'], exclude: ['TSLA'] }));
  process.env.ODYSSEUS_WATCHLIST = 'app';
  wl = new Engine({ watchlistPath: tmp }).watchlist();
  check('the environment can set the scope', wl.scope, 'app');
  check('and the exclude list still applies', wl.exclude, ['TSLA']);
  process.env.ODYSSEUS_WATCHLIST = 'doge, ada';
  wl = new Engine({ watchlistPath: tmp }).watchlist();
  check('or name symbols outright', [wl.scope, wl.symbols], ['watchlist', ['DOGE', 'ADA']]);

  if (saved === undefined) delete process.env.ODYSSEUS_WATCHLIST; else process.env.ODYSSEUS_WATCHLIST = saved;
  fs.unlinkSync(tmp);
});

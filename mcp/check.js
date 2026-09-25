#!/usr/bin/env node
/* check.js — prove the MCP server works, here, on this machine.

     node mcp/check.js                    offline: against the committed fake exchange
     node mcp/check.js --live             online:  against the REAL Bybit API
     node mcp/check.js --live BTC SOL     online, for specific coins

   The --live mode is the one that matters and the one that could not be run
   from the cloud sandbox this was built in: that sandbox's network policy
   blocks api.bybit.com outright. Run it from a machine that can reach Bybit
   and it will tell you, in plain English, whether the engine agrees with the
   exchange.
   part of Odysseus */

'use strict';

const { Engine } = require('./engine.js');
const { buildServer } = require('./server.js');
const { serveHttp } = require('./protocol.js');
const { connectHttp } = require('./client.js');

const args = process.argv.slice(2);
const live = args.includes('--live');
const symbols = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());

const pad = (s, n) => String(s).padEnd(n);
const line = () => console.log('-'.repeat(72));

function grade(v) {
  if (!v || v.grade === 'no signal') return 'no signal';
  return v.grade + (v.hitRate ? '  ' + v.hitRate + ' of ' + v.signals + ', median ' + v.medianMove : '');
}

async function main() {
  let fake = null;
  let engine;

  if (live) {
    console.log('Checking against the REAL Bybit API.\n');
    engine = new Engine({});
  } else {
    const { start } = require('./test/fakebybit.js');
    fake = await start();
    console.log('Checking against the committed fake exchange at ' + fake.url + '.');
    console.log('Run with --live to check against the real Bybit API.\n');
    engine = new Engine({ hostMap: fake.hostMap });
  }

  const picks = symbols.length ? symbols : (live ? ['BTC', 'SOL'] : ['SOL', 'SQUEZ']);

  try {
    /* ---- 1. the engine ---- */
    line();
    console.log('1. ENGINE');
    line();

    for (const sym of picks) {
      const t0 = Date.now();
      const s = await engine.stochSnapshot(sym);
      console.log('\n' + s.symbol + (s.name ? '  (' + s.name + ')' : '') +
                  '   ' + s.market + '   ' + (s.price != null ? s.price : '?') +
                  '   [' + (Date.now() - t0) + 'ms]');
      console.log('  bias ' + s.bias.score + ' (' + s.bias.label + ')' +
                  (s.btcAlignment ? '   BTC alignment ' + s.btcAlignment.pct + '% (' +
                   s.btcAlignment.framesAgreeing + ' agree / ' + s.btcAlignment.framesClashing + ' clash)' : ''));
      for (const [key, f] of Object.entries(s.frames)) {
        console.log('  ' + pad(key, 4) + pad(f.cross.type, 16) +
                    pad(f.cross.level == null ? '' : f.cross.level + ' ' + f.cross.zone, 22) +
                    grade(f.verdict));
      }
      if (s.bestSetup) console.log('  best: ' + s.bestSetup.summary);
    }

    for (const sym of picks) {
      const n = await engine.newsSnapshot(sym, { window: '24h' });
      console.log('\n' + n.symbol + ' — 24h structural read');
      console.log('  ' + n.move.pct + '% vs board median ' + n.move.boardMedianPct + '%  →  ' +
                  n.move.classificationLabel);
      console.log('  ' + n.structuralRead);
      if (n.liquidity.caveat) console.log('  ! ' + n.liquidity.caveat);
      if (n.headlines.length) {
        for (const h of n.headlines.slice(0, 3))
          console.log('  · [' + h.source + '] ' + h.title + '  (' + h.label + ')');
      } else {
        console.log('  · ' + (n.headlineNote || 'no headlines'));
      }
    }

    /* ---- 2. the protocol ---- */
    console.log('');
    line();
    console.log('2. MCP PROTOCOL');
    line();

    const server = buildServer(engine);
    const http = await serveHttp(server, { port: 0, host: '127.0.0.1' });
    const client = await connectHttp(http.url);

    const tools = await client.listTools();
    console.log('handshake ok, ' + tools.length + ' tools: ' + tools.map(t => t.name).join(', '));
    for (const t of tools)
      console.log('  ' + pad(t.name, 22) + (t.annotations && t.annotations.readOnlyHint ? 'read-only' : 'WRITES?'));

    const wl = await client.callTool('get_watchlist', { names: !live });
    console.log('get_watchlist   → ' + wl.count + ' symbols from ' + wl.source);

    const st = await client.callTool('get_stoch_snapshot', { symbol: picks[0] });
    console.log('get_stoch_snapshot → ' + st.symbol + ', ' + Object.keys(st.frames).length + ' frames');

    const nw = await client.callTool('get_news_snapshot', { symbol: picks[0], headlines: false });
    console.log('get_news_snapshot  → ' + nw.symbol + ', ' + nw.window + ', ' + nw.move.pct + '%');

    const cr = await client.callTool('get_crowd_snapshot', { symbol: picks[0] });
    console.log('get_crowd_snapshot → ' + cr.symbol + ', funding ' + cr.funding.nowPctPer8h + '%/8h, ' +
                (cr.read.tag ? cr.read.tag + ' ' + cr.read.score : 'no crowd read') +
                (cr.missing ? '  (missing: ' + cr.missing.join('; ') + ')' : ''));

    await client.close();
    await http.close();

    console.log('');
    line();
    console.log('ALL CHECKS PASSED' + (live ? ' AGAINST LIVE BYBIT' : ' (offline)'));
    line();
  } finally {
    if (fake) await fake.close();
  }
}

main().catch(e => {
  console.error('\nFAILED: ' + (e && e.stack || e));
  console.error('\nIf this is --live and the error mentions CONNECT, 403, or a DNS failure,');
  console.error('the machine or its network policy cannot reach api.bybit.com.');
  process.exit(1);
});

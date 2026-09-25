/* server.js — the Odysseus MCP server.

   Exactly four tools, all read-only, each scoped to one domain:

     get_stoch_snapshot   the indicator and verdict-engine read, and nothing else
     get_news_snapshot    the structural and headline read, and nothing else
     get_crowd_snapshot   the positioning read — funding, open interest, accounts long — and nothing else
     get_watchlist        which coins to look at

   The scoping is load-bearing, not tidiness. The whole point of the two-analyst
   design is that the stochastic analyst and the news analyst are BLIND to each
   other, so that when they agree it means something and when they clash the
   clash is the signal. Blindness has to be structural — separate contexts, and
   separate tool grants — because telling one model to ignore data sitting in
   its own context does not work. Merging these into one tool would quietly
   destroy that, so: do not merge them.

   Run it:
     node server.js                 stdio, for a local desktop MCP client
     node server.js --http          HTTP on ODYSSEUS_PORT (default 8787)

   part of Odysseus */

'use strict';

const path = require('path');
const { Engine } = require('./engine.js');
const { McpServer, serveStdio, serveHttp } = require('./protocol.js');

const pkg = (() => {
  try { return require('./package.json'); } catch (e) { return { version: '0.1.0' }; }
})();

const SYMBOL_SCHEMA = {
  type: 'string',
  description: 'Coin ticker, e.g. "BTC", "SOL", "1000PEPE". A USDT suffix is accepted and stripped.',
  maxLength: 24,
  pattern: '^[A-Za-z0-9._-]{1,24}$',
};

const INSTRUCTIONS = [
  'Odysseus exposes one trading app\'s own read of the Bybit market, computed by the exact code the app runs.',
  '',
  'get_stoch_snapshot gives the multi-timeframe Stochastic (5,3,3) picture and, for every live cross,',
  'a grade from the verdict engine measuring that exact setup (frame + direction + zone) against what it',
  'has actually done on that coin before. Grades are deliberately hard to earn: most crosses sit near a',
  'coin flip and the tool says so. A "negative" or "no edge" grade is a real answer, not a failure.',
  '',
  'get_news_snapshot gives the structural read — how much of a coin\'s move the whole board already',
  'accounts for, which hour the move actually landed in, and what open interest and funding say about',
  'who was on the other side — plus any headlines that name the coin, labelled by whether they broke',
  'before or after the move.',
  '',
  'get_crowd_snapshot gives the positioning read — funding and its history, open interest and how it',
  'moved against price, the share of accounts long, the app\'s own crowd score, and that score recomputed',
  'at every hour of the last week with how each hour then went.',
  '',
  'These tools are deliberately separate and are meant to be used by separate, mutually blind',
  'analysts. If you have been given only one of them, that is intentional: form your call from what you',
  'can see and do not speculate about the other sides.',
  '',
  'Everything here is read-only. Nothing places, cancels or alters an order.',
].join('\n');

/*  Which tools this process exposes.

    This is the mechanism that makes the blind-analyst design actually hold in a
    real MCP client. A client grants a chat every tool a server offers — there
    is no per-conversation tool picking — so one server with both tools means
    any analyst using it can see both sides, and the blindness becomes an
    instruction again, which is exactly what was ruled out.

    So: run TWO processes. One exposes only the stochastic tool, one only the
    news tool, and each analyst is pointed at one of them. Neither can reach the
    other's data because the data is not in its process.

      ODYSSEUS_TOOLS=stoch     get_stoch_snapshot + get_watchlist
      ODYSSEUS_TOOLS=news      get_news_snapshot  + get_watchlist
      ODYSSEUS_TOOLS=crowd     get_crowd_snapshot + get_watchlist
      ODYSSEUS_TOOLS=all       all four (the default — fine for a single
                               operator poking at it by hand, wrong for the
                               analyst flow)

    get_watchlist is in both sets on purpose: it is which coins to look at and
    what they are really called, which leaks nothing about either read.       */
const TOOL_SETS = {
  all:   ['get_stoch_snapshot', 'get_news_snapshot', 'get_crowd_snapshot', 'get_watchlist'],
  stoch: ['get_stoch_snapshot', 'get_watchlist'],
  news:  ['get_news_snapshot', 'get_watchlist'],
  crowd: ['get_crowd_snapshot', 'get_watchlist'],
};

function resolveToolSet(spec) {
  const raw = String(spec == null ? 'all' : spec).trim().toLowerCase();
  if (!raw) return TOOL_SETS.all;
  if (TOOL_SETS[raw]) return TOOL_SETS[raw];
  // an explicit list is allowed too, for anything the named sets do not cover
  const names = raw.split(/[,\s]+/).filter(Boolean);
  const unknown = names.filter(n => !TOOL_SETS.all.includes(n));
  if (unknown.length)
    throw new Error('unknown tool(s): ' + unknown.join(', ') +
                    '. Use one of: ' + Object.keys(TOOL_SETS).join(', ') +
                    ', or a comma-separated list of ' + TOOL_SETS.all.join(', '));
  return names;
}

const SET_INSTRUCTIONS = {
  stoch: '\n\nThis process exposes the INDICATOR side only. The structural and news read lives in a ' +
         'separate process you cannot reach. That is deliberate: form your call from the indicator ' +
         'and the historical record alone, and do not speculate about catalysts or sentiment.',
  news:  '\n\nThis process exposes the STRUCTURAL and NEWS side only. The indicator and verdict read ' +
         'lives in a separate process you cannot reach. That is deliberate: form your call from ' +
         'structure, positioning and headlines alone, and do not speculate about what the ' +
         'stochastic is doing.',
  crowd: '\n\nThis process exposes the POSITIONING side only — funding, open interest, the share of ' +
         'accounts long, and price over the last week. The indicator read and the news read live in ' +
         'separate processes you cannot reach. That is deliberate: form your call from who is ' +
         'positioned where and what it is costing them, and do not speculate about the stochastic, ' +
         'catalysts or headlines.',
};

function buildServer(engine, opts) {
  const o = opts || {};
  const allowed = resolveToolSet(o.tools != null ? o.tools : process.env.ODYSSEUS_TOOLS);
  const setName = Object.keys(TOOL_SETS).find(k =>
    TOOL_SETS[k].length === allowed.length && TOOL_SETS[k].every(n => allowed.includes(n))) || 'custom';

  const server = new McpServer({
    name: setName === 'all' ? 'odysseus' : 'odysseus-' + setName,
    version: pkg.version || '0.1.0',
    instructions: INSTRUCTIONS + (SET_INSTRUCTIONS[setName] || ''),
    log: msg => process.stderr.write('[odysseus] ' + msg + '\n'),
  });
  server.toolSet = setName;
  server.allowedTools = allowed;

  const register = def => { if (allowed.includes(def.name)) server.tool(def); };

  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,     // it reaches the exchange and the news feeds
  };

  register({
    name: 'get_stoch_snapshot',
    title: 'Stochastic and verdict read',
    description:
      'The multi-timeframe Stochastic (5,3,3) read for one coin across 1H/4H/1D/1W/1M, from the ' +
      'trading app\'s own indicator code. Per frame: the current cross (type, direction, whether it ' +
      'is still on the live bar, how many bars ago, its level and zone, %K/%D), any divergence run, ' +
      'the 200 EMA regime, and a verdict-engine grade for the cross measured against every past ' +
      'instance of that same setup on that same coin — hit rate, median move, sample size, and a ' +
      'per-horizon breakdown. Also a timeframe-weighted bias score and how the coin lines up with ' +
      'BTC frame by frame. Also `yourTrackRecord`: this analyst\'s OWN past calls, settled against what ' +
      'price then did — by mark, by direction, by conviction, by setup, on this coin, with recent misses, and its best and worst calls ever net of BTC. ' +
      'This tool knows nothing about news, headlines, social sentiment or catalysts, and it will not ' +
      'tell you why anything moved — only what the indicator and the historical record say.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_SCHEMA,
        force: {
          type: 'boolean',
          description: 'Refetch candles instead of using the short-lived cache. Default false.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: args => engine.stochSnapshot(args.symbol, { force: !!args.force }),
  });

  register({
    name: 'get_news_snapshot',
    title: 'Structural and headline read',
    description:
      'Why a coin moved, as far as exchange data and public headlines can say. Returns the coin\'s ' +
      'move over a 1h/4h/24h window against the median move of the liquid board, classified three ways ' +
      '(market-wide / amplified market move / coin-specific); the single sharpest hour and the volume ' +
      'multiple it printed; the open-interest change and what it implies about positioning (new longs, ' +
      'short squeeze, new shorts, long flush); the funding rate and whether it is crowded; a plain-English ' +
      'structural sentence; and headlines that actually name the coin, each labelled with whether it was ' +
      'published before or after the sharpest hour — a headline after the move is reporting, not cause. ' +
      'Works for coins off the liquid board too; those come back flagged rather than failing. ' +
      'Also `yourTrackRecord`: this analyst\'s OWN past calls, settled against what price then did — by ' +
      'mark, by direction, by conviction, by setup kind, on this coin, with recent misses, and its best and worst calls ever net of BTC. ' +
      'This tool knows nothing about the stochastic, indicator crosses, backtests or trade grades.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_SCHEMA,
        window: {
          type: 'string',
          enum: ['1h', '4h', '24h'],
          description: 'Which move to explain. Default "24h".',
        },
        headlines: {
          type: 'boolean',
          description: 'Include the headline layer. Default true. Set false for the exchange-only read, ' +
                       'which is faster and never depends on a third-party feed being up.',
        },
        force: {
          type: 'boolean',
          description: 'Re-sweep the board instead of using the short-lived cache. Default false.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: args => engine.newsSnapshot(args.symbol, {
      window: args.window || '24h',
      headlines: args.headlines !== false,
      force: !!args.force,
    }),
  });

  register({
    name: 'get_crowd_snapshot',
    title: 'Positioning and crowd read',
    description:
      'The positioning read for one coin on the Bybit perpetual, from the trading app\'s own Crowd code: ' +
      'funding now, its 8-settlement average, annualised, and the last 30 settlements; open interest in ' +
      'dollars and contracts with its 4h/24h/7d change and its ratio to daily turnover; the share of ' +
      'accounts long and its 24h mean; the flow tag (new longs / short squeeze / new shorts / long flush); ' +
      'the app\'s crowd score (crowded, fresh, squeezed, coiled — with the reasons that earned the points) ' +
      'and that same score recomputed at every hour of the last week, graded on where price was 24h ' +
      'later; and the last 48 hours of close, OI and accounts long, hour by hour. Also `yourTrackRecord`: ' +
      'this analyst\'s OWN past calls, settled against what price then did. This tool knows nothing about ' +
      'the stochastic, crosses, backtests, headlines or the web, and it will not guess at them.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL_SCHEMA,
        force: {
          type: 'boolean',
          description: 'Refetch the series instead of using the short-lived cache. Default false.',
        },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    annotations: readOnly,
    handler: args => engine.crowdSnapshot(args.symbol, { force: !!args.force }),
  });

  register({
    name: 'get_watchlist',
    title: 'Watchlist',
    description:
      'The coins this Odysseus instance is watching, with the real coin name for each where it can be ' +
      'resolved. Use the names, not the bare tickers, when searching the web: "GAS", "ID", "OP" and ' +
      '"NEAR" are ordinary English words, and a bare-ticker search returns something unrelated — the ' +
      'app once matched a FLOCK move to an article about security cameras.',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'boolean',
          description: 'Resolve real coin names as well as tickers. Default true.',
        },
      },
      additionalProperties: false,
    },
    annotations: Object.assign({}, readOnly, { openWorldHint: false }),
    handler: async args => {
      await engine.ready();
      const wl = engine.watchlist();
      const wantNames = args.names !== false;
      const symbols = [];
      for (const sym of wl.symbols) {
        const entry = { symbol: sym, pair: engine.g.symbolOf(sym).bybit };
        if (wantNames) {
          try { entry.name = await engine.coinName(sym); } catch (e) { entry.name = null; }
        }
        symbols.push(entry);
      }
      return {
        source: wl.source,
        market: engine.g.marketLabel(),
        count: symbols.length,
        symbols,
      };
    },
  });

  return server;
}

/* ---------- entry point ---------- */

function parseArgs(argv) {
  const out = { http: false, port: null, host: null, tools: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') out.http = true;
    else if (a === '--stdio') out.http = false;
    else if (a === '--port') out.port = +argv[++i];
    else if (a.startsWith('--port=')) out.port = +a.slice(7);
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice(7);
    else if (a === '--tools') out.tools = argv[++i];
    else if (a.startsWith('--tools=')) out.tools = a.slice(8);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = `
Odysseus MCP server

  node server.js                  speak MCP over stdio (for a desktop MCP client)
  node server.js --http           serve MCP over HTTP   (for scheduled/unattended runs)

Options
  --http                          HTTP transport instead of stdio
  --port N / --port=N             HTTP port (default $ODYSSEUS_PORT or 8787)
  --host H / --host=H             bind address (default 127.0.0.1; use 0.0.0.0 to expose)
  --tools stoch|news|crowd|all    which tools this process exposes (default all)

The analyst flow runs THREE processes, so no analyst can see another's
data — blindness by separation, not by instruction:

  node server.js --tools stoch    get_stoch_snapshot + get_watchlist
  node server.js --tools news     get_news_snapshot  + get_watchlist
  node server.js --tools crowd    get_crowd_snapshot + get_watchlist

Environment
  ODYSSEUS_WATCHLIST    comma-separated tickers; overrides mcp/watchlist.json
  ODYSSEUS_MARKET       linear (USDT perpetuals, default) or spot
  ODYSSEUS_MIN_LIQ      24h turnover floor in $m for the board sweep (default 10)
  ODYSSEUS_BOARD_WIDTH  how many of the deepest books to measure (default 90)
  ODYSSEUS_CACHE_MS     how long a snapshot stays warm (default 90000)
  ODYSSEUS_PORT         HTTP port
  ODYSSEUS_TOOLS        stoch | news | crowd | all (default all) — same as --tools
  ODYSSEUS_TOKEN        if set, HTTP requires "Authorization: Bearer <token>"
  ODYSSEUS_HOST_MAP     JSON host->origin rewrites; for tests only
`.trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); return; }

  const engine = new Engine({ watchlistPath: path.join(__dirname, 'watchlist.json') });
  const server = buildServer(engine, { tools: args.tools });
  process.stderr.write('[odysseus] tool set "' + server.toolSet + '": ' + server.allowedTools.join(', ') + '\n');

  if (args.http || process.env.ODYSSEUS_HTTP === '1') {
    const port = args.port || +process.env.ODYSSEUS_PORT || 8787;
    const host = args.host || process.env.ODYSSEUS_HOST || '127.0.0.1';
    const token = process.env.ODYSSEUS_TOKEN || null;
    const live = await serveHttp(server, {
      port, host, token,
      log: msg => process.stderr.write('[odysseus] ' + msg + '\n'),
    });
    process.stderr.write('[odysseus] MCP over HTTP at ' + live.url +
      (token ? ' (bearer token required)' : ' (no token set — bind to 127.0.0.1 or set ODYSSEUS_TOKEN)') + '\n');
    // warm the VM context so the first tool call is not also a cold start
    engine.ready().catch(e => process.stderr.write('[odysseus] warmup failed: ' + e.message + '\n'));
    const stop = () => live.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } else {
    serveStdio(server);
    process.stderr.write('[odysseus] MCP over stdio\n');
  }
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write('[odysseus] fatal: ' + (e && e.stack || e) + '\n');
    process.exit(1);
  });
}

module.exports = { buildServer, resolveToolSet, TOOL_SETS, INSTRUCTIONS };

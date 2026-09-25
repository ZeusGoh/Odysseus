#!/usr/bin/env node
/* bybit-import.js — pull your own closed trades out of Bybit and hand them to
   the journal, without your Bybit password anywhere in the loop.

     ODYSSEUS_BYBIT_KEY / ODYSSEUS_BYBIT_SECRET     a read-only API key you
       generate yourself: Bybit -> API Management -> Create New Key -> System
       generated. Tick "Read-Only", and leave every trade/transfer/withdraw
       permission off. This script only ever calls GET endpoints, but there
       is no reason for the key itself to be able to do more than that. It
       is not, and cannot be, your account password — Bybit doesn't let an
       API key hold one, which is the whole point of using one here.

     node mcp/bybit-import.js                  last 90 days, USDT perpetual
     node mcp/bybit-import.js --days 365        a year back
     node mcp/bybit-import.js --category inverse
     node mcp/bybit-import.js --dry-run         call Bybit, print a summary, write nothing
     node mcp/bybit-import.js --print           print the trades as JSON instead of writing the file
     node mcp/bybit-import.js --out FILE        where the trades land (default: mcp/bybit-trades.json)

   The file this writes is not the journal itself — nothing here can reach
   into your browser. It's read by an "Import Bybit trades" button on the
   app's Journal panel, the same click-to-confirm shape the rest of Odysseus
   uses for anything that adds to your recorded trades: this script proposes,
   you decide when (or whether) it actually lands.

   Only closed derivatives positions are pulled (linear by default, the same
   book market-data.js reads by default) — Bybit's closed-PnL endpoint is
   specific to margin/perp positions. Spot has no equivalent "one row per
   round trip" endpoint; turning a raw stream of spot fills into trades means
   matching buys against sells yourself, which is a real project of its own
   and out of scope here.
   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');
const { bybitHeaders, bybitMapClosedTrades } = require('./bybit.js');

const API = 'https://api.bybit.com';
const DAY = 86400e3;
const WINDOW = 7 * DAY;           // conservative per-request chunk — see header
const PAGE = 100;                 // Bybit's max page size on this endpoint
const DEFAULT_DAYS = 90;
const DEFAULT_OUT = path.join(__dirname, 'bybit-trades.json');

function usage() {
  return [
    'Usage: node mcp/bybit-import.js [options]',
    '',
    '  --days N       how far back to pull (default ' + DEFAULT_DAYS + '; Bybit keeps about 2 years)',
    '  --category C   linear (default) or inverse',
    '  --out FILE     where to write the trades (default mcp/bybit-trades.json)',
    '  --dry-run      call Bybit and print a summary; write nothing',
    '  --print        print the trades as JSON to stdout instead of writing the file',
    '  --help',
    '',
    'Needs $ODYSSEUS_BYBIT_KEY and $ODYSSEUS_BYBIT_SECRET — a read-only API',
    'key from Bybit -> API Management. Never your account password.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, category: 'linear', out: DEFAULT_OUT, dryRun: false, print: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--category') out.category = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--print') out.print = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function bybitPrivateGet(key, secret, endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const headers = Object.assign({ 'content-type': 'application/json' }, bybitHeaders(key, secret, qs));
  const res = await fetch(API + endpoint + '?' + qs, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from Bybit: ' + (body.retMsg || res.statusText));
  if (body.retCode !== 0) throw new Error('Bybit rejected the request: ' + (body.retMsg || body.retCode) +
    (body.retCode === 10003 || body.retCode === 10004 ? ' (check the key/secret, and that the key is enabled for this account)' : ''));
  return body.result;
}

/*  Walks backward from now in WINDOW-sized chunks, paging each with `cursor`
    until Bybit stops handing one back, so neither an undocumented per-request
    range cap nor a page-count limit can silently drop history.              */
async function pullClosedPnl(key, secret, category, days, log) {
  const end = Date.now();
  const start = end - days * DAY;
  const rows = [];
  for (let winEnd = end; winEnd > start; winEnd -= WINDOW) {
    const winStart = Math.max(start, winEnd - WINDOW);
    let cursor = '';
    for (;;) {
      const params = { category, startTime: String(winStart), endTime: String(winEnd), limit: String(PAGE) };
      if (cursor) params.cursor = cursor;
      const result = await bybitPrivateGet(key, secret, '/v5/position/closed-pnl', params);
      const list = result.list || [];
      rows.push(...list);
      cursor = result.nextPageCursor || '';
      if (!cursor || !list.length) break;
    }
    log && log('  ' + new Date(winStart).toISOString().slice(0, 10) + ' → ' +
      new Date(winEnd).toISOString().slice(0, 10) + ': ' + rows.length + ' so far');
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage() + '\n'); return; }

  const key = process.env.ODYSSEUS_BYBIT_KEY, secret = process.env.ODYSSEUS_BYBIT_SECRET;
  if (!key || !secret) {
    process.stderr.write(usage() + '\n\nNo key/secret found in the environment.\n');
    process.exit(1);
  }
  if (!(args.days > 0)) throw new Error('--days must be a positive number');

  process.stderr.write('Pulling closed ' + args.category + ' positions for the last ' + args.days + ' days…\n');
  const rows = await pullClosedPnl(key, secret, args.category, args.days, l => process.stderr.write(l + '\n'));
  const trades = bybitMapClosedTrades(rows);

  process.stderr.write('\n' + rows.length + ' closed position(s) from Bybit, ' + trades.length + ' usable.\n');

  if (args.print) { process.stdout.write(JSON.stringify(trades, null, 2) + '\n'); return; }
  if (args.dryRun) {
    trades.slice(0, 10).forEach(t => process.stderr.write('  ' + t.symbol + ' ' + t.direction +
      '  entry ' + t.entryPrice + ' → exit ' + t.exitPrice + '  size ' + t.size +
      '  ' + new Date(t.entryTime).toISOString().slice(0, 10) + '\n'));
    if (trades.length > 10) process.stderr.write('  … and ' + (trades.length - 10) + ' more\n');
    process.stderr.write('\ndry run — nothing written. Check a few of these against Bybit\'s own trade history\n' +
      'before importing, especially that long/short reads the right way round for you.\n');
    return;
  }

  const payload = { source: 'bybit', category: args.category, generatedAt: new Date().toISOString(), trades };
  fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
  process.stderr.write('\nWrote ' + trades.length + ' trade(s) to ' + args.out + '\n' +
    'Open the app, go to Journal, and click "Import Bybit trades" to bring them in.\n');
}

main().catch(e => {
  process.stderr.write('\nFAILED: ' + (e && e.message || e) + '\n');
  process.exit(1);
});

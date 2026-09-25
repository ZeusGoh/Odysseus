#!/usr/bin/env node
/* bybit.js — turning Bybit's own record of your trades into Odysseus's.

   Bybit's V5 API authenticates with a key/secret pair you generate yourself,
   in Bybit's own API Management page, scoped to read-only if you ask for
   that — never the password you log in with. This file has no opinion about
   how that pair reaches it (mcp/bybit-import.js reads it from the
   environment); it only signs a request once it has one, and only ever asks
   for closed positions — nothing here can place, cancel, or alter an order.

   Split the way score.js and postmortem.js are: the maths — signing, and
   mapping one of Bybit's closed-PnL rows onto the shape journal.js already
   knows how to read — is pure and sits up top, testable with no network and
   no clock of its own; the fetching sits in bybit-import.js.
   part of Odysseus */

'use strict';

const crypto = require('crypto');

/* ==BYBIT_START== */
const RECV_WINDOW = 5000;

/*  Bybit's own recipe for a signed GET: timestamp + key + recvWindow + the
    query string, HMAC-SHA256, hex. Pure given the pieces — no clock, no
    network — so a fixed timestamp in a test pins the signature exactly.    */
function bybitSign(secret, timestamp, apiKey, recvWindow, queryString) {
  const payload = String(timestamp) + String(apiKey) + String(recvWindow) + (queryString || '');
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');
}

function bybitHeaders(apiKey, secret, queryString, now) {
  const timestamp = now || Date.now();
  return {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-TIMESTAMP': String(timestamp),
    'X-BAPI-RECV-WINDOW': String(RECV_WINDOW),
    'X-BAPI-SIGN': bybitSign(secret, timestamp, apiKey, RECV_WINDOW, queryString),
  };
}

/*  One closed-PnL row from Bybit -> one journal trade.

    Nothing on this endpoint carries a stop/invalidation price — Bybit
    doesn't record why a position was sized the way it was, only that it
    closed — so that field is left null, exactly like a trade logged by hand
    with the box left blank. jR and jSizeValue already treat a missing stop
    as "no R to compute", not as zero, so this does not need to invent one.

    `side` here names which way the *position* ran, not which order closed
    it: Buy is a long that got sold out of, Sell is a short that got bought
    back. Map it straight onto direction. If that ever reads backwards for
    you, --dry-run before ever importing is exactly for catching it early.  */
function bybitMapClosedTrade(row, symbolOf) {
  if (!row || !row.symbol) return null;
  const entry = +row.avgEntryPrice, exit = +row.avgExitPrice;
  const qty = +row.closedSize || +row.qty;
  if (!isFinite(entry) || entry <= 0 || !isFinite(exit) || exit <= 0 || !(qty > 0)) return null;
  const direction = row.side === 'Sell' ? 'short' : 'long';
  const sym = symbolOf ? symbolOf(row.symbol) : String(row.symbol).replace(/USDT$/, '');
  const created = +row.createdTime, updated = +row.updatedTime;
  const entryTime = isFinite(created) ? created : (isFinite(updated) ? updated : Date.now());
  const exitTime  = isFinite(updated) ? updated : entryTime;
  return {
    symbol: sym,
    frame: null,
    direction,
    entryPrice: entry,
    entryTime,
    invalidation: null,
    size: qty,
    wave: '',
    notes: 'Imported from Bybit (' + (row.category || 'linear') + ').',
    exitPrice: exit,
    exitTime,
    closeNote: '',
    // namespaced so a future second source can't collide with this one, and
    // stable across re-runs so importing the same window twice adds nothing
    sourceId: 'bybit:' + (row.orderId || row.execId || (row.symbol + ':' + entryTime + ':' + exit)),
  };
}

function bybitMapClosedTrades(rows, symbolOf) {
  return (rows || []).map(r => bybitMapClosedTrade(r, symbolOf)).filter(Boolean);
}
/* ==BYBIT_END== */

module.exports = { RECV_WINDOW, bybitSign, bybitHeaders, bybitMapClosedTrade, bybitMapClosedTrades };

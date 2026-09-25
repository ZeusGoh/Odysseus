/* bybit.test.js — signing Bybit's own recipe correctly, and turning one of
   its closed-PnL rows into a trade journal.js already knows how to read.
   part of Odysseus */

const path = require('path');
const MCP = path.join(__dirname, '..', 'mcp');
const { bybitSign, bybitHeaders, bybitMapClosedTrade, bybitMapClosedTrades } = require(path.join(MCP, 'bybit.js'));
const crypto = require('crypto');

suite('bybitSign — timestamp + key + recvWindow + query, HMAC-SHA256 hex');
{
  const expect = crypto.createHmac('sha256', 'sekrit').update('1700000000000mykey5000cat=BTC').digest('hex');
  check('matches the recipe worked out by hand', bybitSign('sekrit', 1700000000000, 'mykey', 5000, 'cat=BTC'), expect);
  check('an empty query string is just the three pieces concatenated',
        bybitSign('s', 1, 'k', 5000, ''), crypto.createHmac('sha256', 's').update('1k5000').digest('hex'));
  check('a different secret gives a different signature',
        bybitSign('a', 1, 'k', 5000, 'x') !== bybitSign('b', 1, 'k', 5000, 'x'), true);
}

suite('bybitHeaders — the four headers Bybit checks, signature included');
{
  const h = bybitHeaders('mykey', 'sekrit', 'cat=BTC', 1700000000000);
  check('api key header', h['X-BAPI-API-KEY'], 'mykey');
  check('timestamp header, stringified', h['X-BAPI-TIMESTAMP'], '1700000000000');
  check('recv-window header', h['X-BAPI-RECV-WINDOW'], '5000');
  check('sign header matches bybitSign on the same inputs',
        h['X-BAPI-SIGN'], bybitSign('sekrit', 1700000000000, 'mykey', 5000, 'cat=BTC'));
}

const row = (over) => Object.assign({
  symbol: 'SOLUSDT', side: 'Buy', avgEntryPrice: '100.5', avgExitPrice: '110.25',
  closedSize: '3', category: 'linear', orderId: 'ord-1',
  createdTime: '1700000000000', updatedTime: '1700003600000',
}, over);

suite('bybitMapClosedTrade — one Bybit row, one journal trade');
{
  const t = bybitMapClosedTrade(row());
  check('symbol strips the USDT suffix by default', t.symbol, 'SOL');
  check('Buy is a long', t.direction, 'long');
  check('entry/exit come through as numbers', [t.entryPrice, t.exitPrice], [100.5, 110.25]);
  check('size from closedSize', t.size, 3);
  check('created -> entryTime, updated -> exitTime', [t.entryTime, t.exitTime], [1700000000000, 1700003600000]);
  check('no invalidation — Bybit does not carry one', t.invalidation, null);
  check('no frame, no verdict, no analyst source — nothing here fabricates those', [t.frame, t.verdict, t.sourceReport], [null, undefined, undefined]);
  check('status is closed by construction (this endpoint only returns settled positions)', t.exitPrice != null, true);
  check('sourceId is namespaced and carries the order id', t.sourceId, 'bybit:ord-1');
  ok('notes say where this came from', /Imported from Bybit/.test(t.notes));
}
check('Sell is a short', bybitMapClosedTrade(row({side: 'Sell'})).direction, 'short');
check('a custom symbolOf is used instead of the default USDT strip',
      bybitMapClosedTrade(row(), sym => 'X'+sym).symbol, 'XSOLUSDT');
check('falls back to qty when closedSize is absent', bybitMapClosedTrade(row({closedSize: undefined, qty: '2'})).size, 2);
check('falls back to execId when there is no orderId',
      bybitMapClosedTrade(row({orderId: undefined, execId: 'exec-9'})).sourceId, 'bybit:exec-9');
check('missing updatedTime falls back to entryTime for exitTime too',
      bybitMapClosedTrade(row({updatedTime: undefined})).exitTime, 1700000000000);

suite('bybitMapClosedTrade — rejects what it cannot honestly turn into a trade');
check('no symbol at all', bybitMapClosedTrade({}), null);
check('a zero or missing entry price', bybitMapClosedTrade(row({avgEntryPrice: '0'})), null);
check('a zero or missing exit price', bybitMapClosedTrade(row({avgExitPrice: undefined})), null);
check('a zero size', bybitMapClosedTrade(row({closedSize: '0', qty: undefined})), null);
check('null/undefined row does not throw', [bybitMapClosedTrade(null), bybitMapClosedTrade(undefined)], [null, null]);

suite('bybitMapClosedTrades — maps a whole page, dropping the unusable rows');
{
  const rows = [row({orderId: 'a'}), {symbol: 'BAD'}, row({orderId: 'b', side: 'Sell'})];
  const trades = bybitMapClosedTrades(rows);
  check('two of three survive', trades.length, 2);
  check('order preserved', trades.map(t => t.sourceId), ['bybit:a', 'bybit:b']);
  check('an empty or missing list does not throw', [bybitMapClosedTrades([]), bybitMapClosedTrades(null)], [[], []]);
}

/* ---------- the live line: bybit-live.js ---------- */
const live = require(path.join(MCP, 'bybit-live.js'));
const fs = require('fs'), os = require('os');

suite('bybit-live — masking, positions, and what a key profile says');
{
  check('a key is shown by its last four only', live.bybitMaskKey('ABCDEFGH1234'), '••••1234');
  check('a stub of a key is fully hidden', live.bybitMaskKey('ab'), '••••');
  check('no key is nothing', live.bybitMaskKey(''), '');
  const pos = live.bybitMapPosition({ symbol: 'SOLUSDT', side: 'Buy', size: '12.5', avgPrice: '150', markPrice: '156', liqPrice: '120.5',
    leverage: '5', positionValue: '1875', unrealisedPnl: '75', takeProfit: '170', stopLoss: '0', createdTime: '1700000000000', updatedTime: '1700003600000' });
  check('a long from Bybit reads as a long on its coin', [pos.symbol, pos.side, pos.size], ['SOL', 'long', 12.5]);
  check('entry, mark, liquidation, leverage', [pos.entry, pos.mark, pos.liq, pos.leverage], [150, 156, 120.5, 5]);
  check('unrealised in dollars and percent of entry', [pos.unrealised, pos.unrealisedPct], [75, 4]);
  check('and on margin, which is what the leverage does to it', pos.marginPct, 20);
  check('a zero stop is no stop', [pos.stopLoss, pos.takeProfit], [null, 170]);
  const short = live.bybitMapPosition({ symbol: 'ETHUSDT', side: 'Sell', size: '1', avgPrice: '3000', markPrice: '3090', leverage: '2', positionValue: '3090', unrealisedPnl: '-90' });
  check('a short that went up is under water', [short.side, short.unrealisedPct], ['short', -3]);
  check('a slot with no size is dropped', live.bybitMapPosition({ symbol: 'BTCUSDT', side: 'None', size: '0' }), null);
  check('positions are sorted biggest first', live.bybitMapPositions([
    { symbol: 'A', side: 'Buy', size: '1', avgPrice: '1', markPrice: '1', positionValue: '10' },
    { symbol: 'B', side: 'Buy', size: '1', avgPrice: '1', markPrice: '1', positionValue: '90' }]).map(p => p.symbol), ['B', 'A']);
  const prof = live.bybitKeyProfile({ readOnly: 1, permissions: { ContractTrade: ['Position'], Wallet: ['AccountTransfer'] }, expiredAt: '-1', note: 'odysseus' });
  check('read-only is read off the flag', prof.readOnly, true);
  check('grants are counted', prof.grants, 2);
  check('no expiry is null', prof.expiresAt, null);
  check('a key that can trade is not read-only', live.bybitKeyProfile({ readOnly: 0 }).readOnly, false);
}

suite('bybit-live — the key file: saved with the profile, loaded, forgotten; the environment as fallback');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odysseus-bybit-'));
  const savedEnv = [process.env.ODYSSEUS_BYBIT_KEY, process.env.ODYSSEUS_BYBIT_SECRET];
  delete process.env.ODYSSEUS_BYBIT_KEY; delete process.env.ODYSSEUS_BYBIT_SECRET;
  check('nothing saved, nothing in the environment: not connected', live.bybitLoadKey(dir), null);
  live.bybitSaveKey(dir, 'KEY123456', 'SECRET', { readOnly: true });
  const k = live.bybitLoadKey(dir);
  check('the pair comes back from the file, marked as such', [k.key, k.secret, k.source, k.readOnly], ['KEY123456', 'SECRET', 'file', true]);
  ok('the file is the one place it lives', fs.existsSync(path.join(dir, live.KEY_FILE)));
  check('forgetting deletes it', [live.bybitForgetKey(dir), live.bybitLoadKey(dir)], [true, null]);
  check('forgetting twice is fine', live.bybitForgetKey(dir), false);
  process.env.ODYSSEUS_BYBIT_KEY = 'ENVKEY'; process.env.ODYSSEUS_BYBIT_SECRET = 'ENVSEC';
  check('the environment is the fallback, and says so', [live.bybitLoadKey(dir).key, live.bybitLoadKey(dir).source], ['ENVKEY', 'env']);
  if (savedEnv[0] === undefined) delete process.env.ODYSSEUS_BYBIT_KEY; else process.env.ODYSSEUS_BYBIT_KEY = savedEnv[0];
  if (savedEnv[1] === undefined) delete process.env.ODYSSEUS_BYBIT_SECRET; else process.env.ODYSSEUS_BYBIT_SECRET = savedEnv[1];
  fs.rmSync(dir, { recursive: true, force: true });
}

later(async () => {
  suite('bybit-live — signed requests against a fake exchange');
  const seen = [];
  const fake = async (url, opts) => {
    const u = new URL(url);
    seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), headers: opts.headers });
    const ok = result => ({ ok: true, json: async () => ({ retCode: 0, retMsg: 'OK', result }) });
    if (u.pathname === '/v5/user/query-api') return ok({ readOnly: 1, permissions: { ContractTrade: ['Position'] }, expiredAt: '-1' });
    if (u.pathname === '/v5/position/list') {
      if (!u.searchParams.get('cursor')) return ok({ list: [{ symbol: 'SOLUSDT', side: 'Buy', size: '2', avgPrice: '150', markPrice: '151', positionValue: '302', unrealisedPnl: '2', leverage: '3' }], nextPageCursor: 'p2' });
      return ok({ list: [{ symbol: 'ETHUSDT', side: 'Sell', size: '1', avgPrice: '3000', markPrice: '2990', positionValue: '2990', unrealisedPnl: '10', leverage: '1' }], nextPageCursor: '' });
    }
    if (u.pathname === '/v5/position/closed-pnl') return ok({ list: [{ symbol: 'SOLUSDT', side: 'Buy', avgEntryPrice: '140', avgExitPrice: '150', closedSize: '2', orderId: 'o1', createdTime: '1700000000000', updatedTime: '1700003600000' }], nextPageCursor: '' });
    if (u.pathname === '/v5/bad') return { ok: true, json: async () => ({ retCode: 10003, retMsg: 'API key is invalid.' }) };
    return { ok: false, status: 404, statusText: 'nope', json: async () => ({}) };
  };
  const prof = await live.bybitVerify('K', 'S', fake);
  check('verify asks Bybit what the key is and reads the answer', [prof.readOnly, prof.grants], [true, 1]);
  ok('every request is signed with the four headers', seen[0].headers['X-BAPI-API-KEY'] === 'K' && /^[0-9a-f]{64}$/.test(seen[0].headers['X-BAPI-SIGN']));
  const pos = await live.bybitPositions('K', 'S', null, fake);
  check('positions are paged with the cursor and mapped', pos.map(p => p.symbol + ':' + p.side), ['ETH:short', 'SOL:long']);
  check('the list is asked for USDT linear only', [seen[1].q.category, seen[1].q.settleCoin, seen[2].q.cursor], ['linear', 'USDT', 'p2']);
  const trades = await live.bybitClosedTrades('K', 'S', 3, null, fake);
  check('closed trades come back in the journal\'s shape', [trades[0].symbol, trades[0].direction, trades[0].entryPrice, trades[0].exitPrice, trades[0].sourceId], ['SOL', 'long', 140, 150, 'bybit:o1']);
  let err = null;
  try { await live.bybitPrivateGet('K', 'S', '/v5/bad', {}, fake); } catch (e) { err = e.message; }
  ok('a rejected key says so, with Bybit\'s reason and a hint', /API key is invalid/.test(err) && /check the key and secret/.test(err));
  err = null;
  try { await live.bybitPrivateGet('K', 'S', '/v5/none', {}, fake); } catch (e) { err = e.message; }
  ok('an HTTP failure is named', /HTTP 404/.test(err));
});

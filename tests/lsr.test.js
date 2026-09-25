/* lsr.test.js — the long/short ratio across exchanges: every feed becomes the same hourly
   buckets of taker volume, a window is the last N buckets with this hour included, a tape
   is counted only once it covers the window, the total is dollars summed over the exchanges
   that do, and the read is flow against price.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['lsr.js']);
const {lsrBuckets, lsrFromBinanceTaker, lsrFromBitgetTaker, lsrFromGateTaker, lsrTapeNew, lsrTapeAdd, lsrTapeBuckets,
       lsrWindow, lsrShares, lsrExchange, lsrAggregate, lsrSeries, lsrRead, lsrPriceChange,
       LSR_EXCHANGES, LSR_WINDOWS, LSR_MIN_EXCHANGES, LSR_KEEP_H, LSR_PRESS} = app;

const H = 3600000;
const T0 = Date.UTC(2026, 8, 24, 0);          // 00:00
const NOW = T0 + 3 * H + 40 * 60000;          // 03:40 — the 03:00 bucket is the partial one

suite('lsr — every feed becomes the same hourly buckets, in coins');
{
  const bn = lsrFromBinanceTaker([{ buyVol: '10', sellVol: '20', timestamp: T0 + H }, { buyVol: '5', sellVol: '5', timestamp: T0 }]);
  check('Binance: buyVol/sellVol, sorted ascending whatever the API order', bn.map(b => [b.t, b.buy, b.sell]), [[T0, 5, 5], [T0 + H, 10, 20]]);
  const live = lsrFromBinanceTaker(
    [{ buyVol: '10', sellVol: '20', timestamp: T0 + H }],
    [{ buyVol: '1', sellVol: '1', timestamp: T0 + H + 10 * 60000 }, { buyVol: '2', sellVol: '3', timestamp: T0 + 2 * H }, { buyVol: '4', sellVol: '1', timestamp: T0 + 2 * H + 5 * 60000 }]);
  check('the hour Binance has not closed yet is built from its 5-minute rows; a closed hour keeps its hourly figure', live.map(b => [b.t, b.buy, b.sell]), [[T0 + H, 10, 20], [T0 + 2 * H, 6, 4]]);
  check('no 5-minute rows is fine', lsrFromBinanceTaker([{ buyVol: '1', sellVol: '1', timestamp: T0 }], null).length, 1);
  const bg = lsrFromBitgetTaker([{ buyVolume: '1.5', sellVolume: '0.5', ts: String(T0 + 2 * H + 1) }]);
  check('Bitget: buyVolume/sellVolume, the stamp floored to the hour', bg, [{ t: T0 + 2 * H, buy: 1.5, sell: 0.5 }]);
  const gt = lsrFromGateTaker([{ time: T0 / 1000, long_taker_size: 41867183, short_taker_size: 20000000 }], '0.0001');
  near('Gate: contracts times the multiplier', gt[0].buy, 4186.7183, 1e-6);
  check('Gate without a multiplier is nothing, not a wrong number', lsrFromGateTaker([{ time: 1, long_taker_size: 1, short_taker_size: 1 }], null), []);
  check('a row with a broken number is dropped, not zeroed', lsrBuckets([{ t: T0, b: 'x', s: 1 }, { t: T0 + H, b: 2, s: 1 }], r => r.t, r => r.b, r => r.s).length, 1);
  check('nothing in, nothing out, no throw', [lsrFromBinanceTaker(null), lsrFromBitgetTaker(undefined)], [[], []]);
  check('five exchanges, in the board\'s order', LSR_EXCHANGES.map(e => e.key), ['binance', 'okx', 'bybit', 'gate', 'bitget']);
  check('two of them are tapes', LSR_EXCHANGES.filter(e => e.how === 'tape').map(e => e.key), ['okx', 'bybit']);
  check('three windows', LSR_WINDOWS.map(w => w.hours), [1, 4, 24]);
}

suite('lsr — a tape is the same buckets, built trade by trade');
{
  const tape = lsrTapeNew(NOW - 20 * 60000);
  lsrTapeAdd(tape, [{ t: NOW - 60000, side: 'buy', size: 0.5 }, { t: NOW - 30000, side: 'sell', size: 0.25 }, { t: NOW - 10000, side: 'buy', size: '0.1' }]);
  lsrTapeAdd(tape, [{ t: NOW - H, side: 'sell', size: 1 }, { t: NOW, side: 'hold', size: 9 }, { t: NOW, side: 'buy', size: -1 }]);
  const b = lsrTapeBuckets(tape, NOW);
  check('trades land in their hour', b.map(x => [x.t, +x.buy.toFixed(2), x.sell]), [[T0 + 2 * H, 0, 1], [T0 + 3 * H, 0.6, 0.25]]);
  check('a side that is neither buy nor sell, or a size that is not positive, is skipped', tape.trades, 4);
  lsrTapeAdd(tape, [{ t: NOW - (LSR_KEEP_H + 2) * H, side: 'buy', size: 1 }]);
  check('buckets older than the kept span are dropped on read', lsrTapeBuckets(tape, NOW).length, 2);
}

suite('lsr — a window is the last N hours with this hour included');
{
  const buckets = [0, 1, 2, 3].map(i => ({ t: T0 + i * H, buy: 10 * (i + 1), sell: 5 }));
  const w1 = lsrWindow(buckets, 1, NOW);
  check('1h is the current, partial hour', [w1.buy, w1.sell, w1.n], [40, 5, 1]);
  const w4 = lsrWindow(buckets, 4, NOW);
  check('4h is this hour and the three before it', [w4.buy, w4.sell, w4.n, w4.from], [100, 20, 4, T0]);
  check('24h with only four hours of buckets is those four, and says so', lsrWindow(buckets, 24, NOW).n, 4);
  check('shares: long and short percent, and longs per short', lsrShares(60, 40), { longPct: 60, shortPct: 40, ratio: 1.5 });
  check('no volume is no share, not NaN', lsrShares(0, 0), { longPct: null, shortPct: null, ratio: null });
  check('all buys has no ratio (nothing to divide by) but a full long share', lsrShares(3, 0), { longPct: 100, shortPct: 0, ratio: null });
}

suite('lsr — one exchange over one window, in coins and dollars');
{
  const buckets = [0, 1, 2, 3].map(i => ({ t: T0 + i * H, buy: 2, sell: 1 }));
  const e = lsrExchange('binance', buckets, 80000, 4, { now: NOW });
  check('coins and dollars at the given price', [e.buy, e.sell, e.buyUsd, e.sellUsd, e.volumeUsd], [8, 4, 640000, 320000, 960000]);
  check('the shares', [e.longPct, e.shortPct, e.ratio], [66.67, 33.33, 2]);
  check('a bucket feed always covers its window', [e.how, e.covered, e.coverage], ['buckets', true, null]);
  check('no price: coins still, dollars not', lsrExchange('gate', buckets, null, 4, { now: NOW }).buyUsd, null);
  check('no volume at all reads as nothing rather than 0/0', lsrExchange('bitget', [], 80000, 4, { now: NOW }).longPct, null);
  // a tape that started 20 minutes ago covers half of the 40-minute-old hour and none of 4h
  const t1 = lsrExchange('bybit', buckets, 80000, 1, { now: NOW, since: NOW - 20 * 60000 });
  near('a tape 20 minutes into a 40-minute hour covers half of 1h', t1.coverage, 0.5, 1e-9);
  check('and is not yet counted', t1.covered, false);
  const t4 = lsrExchange('bybit', buckets, 80000, 4, { now: NOW, since: NOW - 4 * H });
  check('a tape older than the window covers it whole', [t4.coverage, t4.covered], [1, true]);
  check('a tape that never started covers nothing', lsrExchange('okx', [], 80000, 1, { now: NOW }).coverage, 0);
}

suite('lsr — the total is dollars over the exchanges that cover the window');
{
  const mk = (key, buyUsd, sellUsd, covered) => ({ key, label: key, how: covered ? 'buckets' : 'tape', buyUsd, sellUsd, volumeUsd: buyUsd + sellUsd, covered, longPct: 1, shortPct: 1, ratio: 1 });
  const agg = lsrAggregate([mk('binance', 300, 100, true), mk('gate', 100, 100, true), mk('bybit', 1000, 0, false), { key: 'okx', label: 'OKX', how: 'tape', buyUsd: null, sellUsd: null, covered: false }]);
  check('summed over the covered exchanges only', [agg.buyUsd, agg.sellUsd, agg.volumeUsd, agg.n], [400, 200, 600, 2]);
  check('with the shares of the sum', [agg.longPct, agg.shortPct, agg.ratio], [66.67, 33.33, 2]);
  check('the filling tape is named as partial, the empty one is not', agg.partial, ['bybit']);
  check('rows are sorted by volume, the biggest first, and carry their share of the sum', agg.exchanges.map(e => [e.key, e.share]), [['bybit', null], ['binance', 66.7], ['gate', 33.3], ['okx', null]]);
  check('nothing covered is a null total, not zero', lsrAggregate([mk('bybit', 5, 5, false)]).volumeUsd, null);
}

suite('lsr — the hourly line needs two exchanges an hour, and a tape only for whole hours');
{
  const a = { buckets: [0, 1, 2].map(i => ({ t: T0 + i * H, buy: 6, sell: 4 })) };
  const b = { buckets: [0, 1].map(i => ({ t: T0 + i * H, buy: 4, sell: 6 })) };
  const s = lsrSeries([a, b], NOW);
  check('hours with both are kept, the lone third is dropped', s.map(p => p.t), [T0, T0 + H]);
  check('each hour is the buy share of the summed coins', s.map(p => p.v), [50, 50]);
  check('with the count carried', s[0].n, 2);
  check('the floor is two', LSR_MIN_EXCHANGES, 2);
  const tape = { since: T0 + 30 * 60000, buckets: [0, 1, 2].map(i => ({ t: T0 + i * H, buy: 10, sell: 0 })) };
  const s2 = lsrSeries([a, tape], NOW);
  check('a tape that joined at 00:30 counts from 01:00, not for the hour it saw in part', s2.map(p => [p.t, p.v]), [[T0 + H, 80], [T0 + 2 * H, 80]]);
  check('buckets older than the kept span are not drawn', lsrSeries([{ buckets: [{ t: T0 - 100 * H, buy: 1, sell: 1 }] }, { buckets: [{ t: T0 - 100 * H, buy: 1, sell: 1 }] }], NOW), []);
}

suite('lsr — the read is flow against price');
{
  check('the press line is 55', LSR_PRESS, 55);
  check('buyers pressing and price up: the flow is paid, lean long', [lsrRead({ longPct: 58 }, 1.2).word, lsrRead({ longPct: 58 }, 1.2).lean], ['buyers pressing', 'bull']);
  check('sellers pressing and price down: lean short', lsrRead({ longPct: 44 }, -2.8).lean, 'bear');
  check('sellers hitting into a rising price is absorption: lean long', [lsrRead({ longPct: 42 }, 0.9).lean, /absorbed/.test(lsrRead({ longPct: 42 }, 0.9).why)], ['bull', true]);
  check('buyers hitting into a falling price is absorption the other way: lean short', lsrRead({ longPct: 57 }, -1).lean, 'bear');
  check('inside the band it is a balanced tape with no lean', [lsrRead({ longPct: 50.5 }, -3).word, lsrRead({ longPct: 50.5 }, -3).lean], ['balanced tape', null]);
  check('pressing with no price to compare reads the flow alone', [lsrRead({ longPct: 60 }, null).word, lsrRead({ longPct: 60 }, null).lean], ['buyers pressing', null]);
  check('no data reads as nothing', lsrRead({ longPct: null }, 1).word, null);
  const candles = [0, 1, 2, 3].map(i => ({ t: T0 + i * H, o: 100 + i, h: 0, l: 0, c: 101 + i }));
  check('price change over 4h: close now against the open of the hour that starts the window', lsrPriceChange(candles, 4, NOW), 4);
  check('over 1h: against this hour\'s open', lsrPriceChange(candles, 1, NOW), +((104 - 103) / 103 * 100).toFixed(2));
  check('candles that do not reach back read as null, not a partial move', lsrPriceChange(candles.slice(2), 24, NOW), null);
  check('no candles, null', lsrPriceChange([], 4, NOW), null);
}

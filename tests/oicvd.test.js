/* oicvd.test.js — CVD is the running sum of taker buys minus taker sells from the bar's own
   taker-buy share, open interest rows become a series, and the read names what positions
   did, which market led, and whether the hitting got paid.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['oicvd.js']);
const {cvdFromKlines, oiFromHist, oicvdRead, OICVD_WINDOWS, OICVD_FLAT_OI, OICVD_FLAT_PX} = app;

const T0 = Date.UTC(2026, 8, 25, 0);
const bar = (i, close, vol, takerBuy) => [T0 + i * 900e3, '1', '1', '1', String(close), String(vol), 0, '0', 1, String(takerBuy), '0', '0'];

suite('oicvd — CVD from the bar\'s taker-buy share');
{
  const s = cvdFromKlines([bar(0, 100, 10, 7), bar(1, 101, 10, 3), bar(2, 102, 4, 4)]);
  check('delta is taker buys minus taker sells: 2·buy − volume', s.map(p => p.delta), [4, -4, 4]);
  check('and the sum runs from zero at the first bar', s.map(p => p.cum), [4, 0, 4]);
  check('the close rides along for the read', s.map(p => p.close), [100, 101, 102]);
  check('a broken row is skipped, not zeroed', cvdFromKlines([bar(0, 100, 'x', 1), bar(1, 100, 2, 1)]).length, 1);
  check('rows come back ascending whatever the order in', cvdFromKlines([bar(1, 1, 2, 1), bar(0, 1, 2, 1)]).map(p => p.t), [T0, T0 + 900e3]);
  check('nothing in, nothing out', cvdFromKlines(null), []);
}

suite('oicvd — open interest rows');
{
  const s = oiFromHist([{ timestamp: T0 + 900e3, sumOpenInterest: '97000.5', sumOpenInterestValue: '8.1e9' }, { timestamp: T0, sumOpenInterest: '96000', sumOpenInterestValue: '8.0e9' }]);
  check('coins and dollars, ascending', s.map(p => [p.t, p.oi, p.oiUsd]), [[T0, 96000, 8.0e9], [T0 + 900e3, 97000.5, 8.1e9]]);
  check('four windows, 15-minute bars for a day and three, hourly for a week, 4-hourly for a month', OICVD_WINDOWS.map(w => w.key + ':' + w.interval), ['24h:15m', '3d:15m', '7d:1h', '30d:4h']);
}

suite('oicvd — the read');
{
  const series = (closes, deltas) => closes.map((c, i) => ({ t: T0 + i * 900e3, close: c, delta: deltas[i], cum: deltas.slice(0, i + 1).reduce((a, b) => a + b, 0) }));
  const oi = (a, b) => [{ t: T0, oi: a }, { t: T0 + 900e3, oi: b }];
  check('the flat bands', [OICVD_FLAT_OI, OICVD_FLAT_PX], [1, 0.5]);
  let r = oicvdRead({ perp: series([100, 102], [5, 5]), spot: series([100, 102], [3, 3]), oi: oi(100, 103) });
  check('price up, OI up, both buying, paid: longs opening, lean long', [r.positions, r.led, r.flow, r.lean], ['longs opening', 'both buying', 'buying, paid', 'bull']);
  check('with the numbers behind it', [r.priceChg, r.oiChg, r.perpCvd, r.spotCvd], [2, 3, 10, 6]);
  r = oicvdRead({ perp: series([100, 98], [-5, -5]), spot: series([100, 98], [-1, -1]), oi: oi(100, 103) });
  check('price down on rising OI with selling paid: shorts opening, lean short', [r.positions, r.flow, r.lean], ['shorts opening', 'selling, paid', 'bear']);
  r = oicvdRead({ perp: series([100, 102], [-2, -2]), spot: series([100, 102], [-1, -1]), oi: oi(100, 97) });
  check('price up on falling OI with net selling: short covering, sellers absorbed → lean long (a squeeze)', [r.positions, r.flow, r.lean], ['short covering', 'selling absorbed', 'bull']);
  r = oicvdRead({ perp: series([100, 98], [4, 4]), spot: series([100, 98], [1, 1]), oi: oi(100, 97) });
  check('price down on falling OI with net buying: longs closing, buyers absorbed → lean short', [r.positions, r.flow, r.lean], ['longs closing', 'buying absorbed', 'bear']);
  r = oicvdRead({ perp: series([100, 102], [5, 5]), spot: series([100, 102], [-3, -3]), oi: oi(100, 103) });
  check('longs opening on leverage while spot sells: perp-led, and no long lean', [r.led, r.lean], ['perp-led', 'bear']);
  r = oicvdRead({ perp: series([100, 98], [-6, -6]), spot: series([100, 98], [8, 8]), oi: oi(100, 103) });
  check('shorts opening into spot buying is squeeze fuel: spot-led, lean long', [r.positions, r.led, r.lean], ['shorts opening', 'spot-led', 'bull']);
  r = oicvdRead({ perp: series([100, 100.1], [1, 1]), spot: series([100, 100.1], [1, 1]), oi: oi(100, 100.2) });
  check('inside the bands everything is flat and there is no lean', [r.positions, r.flow, r.lean], ['flat', 'undecided', null]);
  r = oicvdRead({ perp: series([100, 100.1], [1, 1]), spot: [], oi: oi(100, 102) });
  check('OI up on a flat price is positions building; no spot means no market-led call', [r.positions, r.led, r.spotCvd], ['positions building', null, null]);
  r = oicvdRead({ perp: [], spot: [], oi: [] });
  check('nothing reads as nothing', [r.positions, r.led, r.flow, r.lean, r.priceChg], [null, null, null, null, null]);
}

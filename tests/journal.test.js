/* journal.test.js — position sizing, R-multiples, and the stats rollups,
   including the veto check: does jGradeStats actually read the verdict
   engine's own grades rather than something journal.js invented.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['cloud.js','indicators.js','market-data.js','storage.js','state.js','backtest.js',
                   'btc-reference.js','logan.js','verdict.js','journal.js']);
const {jR, jPct, jSuggestSize, jRiskUnit, jSizePlan, jRiskAmount, jRiskPctOf, jStats, jGradeStats, jAdd, jClose,
       jGroupStats, jHourBlockOf, jWeekdayOf, jMonthOf, jZoneAt, zoneOf,
       J_HOUR_BLOCKS, stoch} = app;

suite('position sizing — (account × risk%) ÷ (entry − invalidation)');
check('a $1,000 account risking 1% against a $10 stop buys 1 unit',
      jSuggestSize(100, 90, 1000, 1), 1);
check('a tighter stop (closer invalidation) sizes bigger for the same risk',
      jSuggestSize(100, 95, 1000, 1), 2);
check('works the same shape for a short (invalidation above entry)',
      jSuggestSize(100, 110, 1000, 1), 1);
check('no account means no suggestion, not a divide-by-zero', jSuggestSize(100, 90, 0, 1), null);
check('entry equal to invalidation has no risk unit to size against',
      jSuggestSize(100, 100, 1000, 1), null);

suite('R-multiple — the same risk unit the sizing formula uses');
{
  const long = {direction:'long', entryPrice:100, invalidation:90};
  check('risk unit is the distance to invalidation', jRiskUnit(long), 10);
  check('a move of the full risk unit in your favour is +1R', jR(long, 110), 1);
  check('hitting the invalidation exactly is -1R', jR(long, 90), -1);
  check('halfway to target is +0.5R', jR(long, 105), 0.5);
  check('no price yet reads as unknown, not zero', jR(long, null), null);

  const short = {direction:'short', entryPrice:100, invalidation:110};
  check('a short profits when price falls, same +1R at one risk unit', jR(short, 90), 1);
  check('a short losing is price rising toward invalidation', jR(short, 110), -1);

  check('percent return respects direction the same way as R', jPct(long, 110), 10);
  check('a short position\'s percent return is sign-flipped', jPct(short, 90), 10);
}

suite('jStats — closed trades only, wins vs losses vs everything');
{
  const rows = [
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:110},   // +1R
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:130},   // +3R
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:90},    // -1R
    {status:'open',   direction:'long', entryPrice:100, invalidation:90, exitPrice:null},  // ignored — still open
  ];
  const s = jStats(rows);
  check('only closed trades count toward the sample', s.n, 3);
  check('win rate is 2 of 3', s.winRate, 67);
  check('average winning R', s.avgWinR, 2);
  check('average losing R', s.avgLossR, -1);
  check('total R booked', s.totalR, 3);
  check('expectancy is the mean R across everything closed', s.expectancy, 1);
  check('no closed trades yet returns null rather than NaN', jStats([]), null);
  check('an all-open journal also returns null', jStats([rows[3]]), null);
}

suite('jGradeStats — does the verdict engine\'s own grade actually predict the outcome');
{
  const rows = [
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:130, verdict:{grade:'strong'}},
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:110, verdict:{grade:'strong'}},
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:90,  verdict:{grade:'thin'}},
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:95,  verdict:null},          // no snapshot — excluded
  ];
  const g = jGradeStats(rows);
  const strong = g.find(x=>x.grade==='strong'), thin = g.find(x=>x.grade==='thin');
  check('a trade logged with no verdict snapshot is excluded rather than miscounted',
        g.reduce((n,x)=>n+x.n,0), 3);
  check('strong-graded trades are grouped together', strong.n, 2);
  check('and their average R is computed correctly', strong.avgR, 2);
  check('thin-graded trades are kept separate', thin.n, 1);
  ok('strong outperforming thin in this sample is visible in the breakdown, not buried',
     strong.avgR > thin.avgR);
}

suite('jAdd / jClose — the CRUD path end to end');
{
  const rowsBefore = [];
  const t = jAdd({symbol:'BTC', frame:'1D', direction:'long', entryPrice:100, invalidation:90, size:1});
  check('a new trade starts open', t.status, 'open');
  ok('gets a unique id', typeof t.id === 'string' && t.id.length > 0);
  const closed = jClose(t.id, 120);
  check('closing sets the exit price', closed.exitPrice, 120);
  check('and flips status', closed.status, 'closed');
  check('closing an id that does not exist is a no-op, not a throw', jClose('nope', 100), null);
}

suite('jAdd / jClose — custom entry/exit times for backdated logging');
{
  const entryTime = new Date(2026,0,15,10,0).getTime();
  const exitTime = new Date(2026,0,16,14,0).getTime();
  const t = jAdd({symbol:'ETH', frame:'4H', direction:'long', entryPrice:100, invalidation:90, size:1, entryTime});
  check('a supplied entryTime is used as-is, not overwritten with now', t.entryTime, entryTime);
  const closed = jClose(t.id, 120, exitTime);
  check('a supplied exitTime is used as-is', closed.exitTime, exitTime);

  const t2 = jAdd({symbol:'ETH', frame:'4H', direction:'long', entryPrice:100, invalidation:90, size:1});
  ok('omitting entryTime falls back to now', Math.abs(Date.now() - t2.entryTime) < 2000);
  const closed2 = jClose(t2.id, 120);
  ok('omitting exitTime falls back to now', Math.abs(Date.now() - closed2.exitTime) < 2000);

  const t3 = jAdd({symbol:'ETH', frame:'4H', direction:'long', entryPrice:100, invalidation:90, size:1, entryTime:NaN});
  ok('an invalid entryTime is treated the same as missing', Math.abs(Date.now() - t3.entryTime) < 2000);
}

suite('jHourBlockOf / jWeekdayOf / jMonthOf — when a trade was actually taken');
{
  const at = (y,m,d,h,mi) => ({entryTime: new Date(y,m,d,h,mi||0).getTime()});
  check('02:00 lands in the 00–04 block', jHourBlockOf(at(2026,0,20,2)), '00–04');
  check('09:00 lands in the 08–12 block', jHourBlockOf(at(2026,0,20,9)), '08–12');
  check('23:30 lands in the 20–24 block', jHourBlockOf(at(2026,0,20,23,30)), '20–24');

  check('Jan 15 2026 is a Thursday', jWeekdayOf(at(2026,0,15,10)), 'Thu');
  check('Jan 19 2026 is a Monday', jWeekdayOf(at(2026,0,19,10)), 'Mon');

  check('a January trade is grouped into "Jan 2026"', jMonthOf(at(2026,0,15,10)), 'Jan 2026');
  check('a February trade is grouped separately', jMonthOf(at(2026,1,3,10)), 'Feb 2026');
}

suite('jGroupStats — the generic grouping the Patterns cards are built from');
{
  const at = (y,m,d,h) => new Date(y,m,d,h,0).getTime();
  const rows = [
    // two morning (08–12) trades, one winner one loser; one afternoon (12–16) winner; one open (excluded)
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:120, entryTime:at(2026,0,10,9)},   // +2R, 08–12
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:90,  entryTime:at(2026,0,11,10)},  // -1R, 08–12
    {status:'closed', direction:'long', entryPrice:100, invalidation:90, exitPrice:130, entryTime:at(2026,0,12,13)}, // +3R, 12–16
    {status:'open',   direction:'long', entryPrice:100, invalidation:90, exitPrice:null, entryTime:at(2026,0,13,9)},
  ];
  const withOrder = jGroupStats(rows, jHourBlockOf, J_HOUR_BLOCKS);
  const morning = withOrder.find(r=>r.key==='08–12'), afternoon = withOrder.find(r=>r.key==='12–16');
  check('an open trade is excluded from every grouping', withOrder.reduce((n,r)=>n+r.n,0), 3);
  check('the 08–12 block groups both morning trades', morning.n, 2);
  check('its win rate reflects one win of two', morning.winRate, 50);
  check('and its average R nets the winner against the loser', morning.avgR, 0.5);
  check('the 12–16 block keeps its one trade separate', afternoon.n, 1);
  ok('a fixed order is followed rather than sorted some other way',
     withOrder.findIndex(r=>r.key==='08–12') < withOrder.findIndex(r=>r.key==='12–16'));

  const noOrder = jGroupStats(rows, jMonthOf, null);
  check('with no fixed order, an open-ended key still groups correctly', noOrder.length, 1);
  check('and reads "Jan 2026"', noOrder[0].key, 'Jan 2026');

  check('a keyFn returning null for every row yields no groups', jGroupStats(rows, ()=>null, null), []);
}

suite('jZoneAt — reconstructing the stochastic zone at a past moment, not the live one');
{
  const t0 = new Date(2026,0,1,0,0).getTime();
  const t1 = new Date(2026,0,2,0,0).getTime();
  const t2 = new Date(2026,0,3,0,0).getTime();
  stoch.ZTEST = { '1D': {
    candles: [{t:t0},{t:t1},{t:t2}],
    k: [10, 50, 90],
    d: [15, 55, 85],
  }};
  check('a candle at 12.5 (avg of 10/15) reads as oversold', zoneOf((10+15)/2), 'oversold');

  check('a time exactly on the first candle reads that candle\'s zone', jZoneAt('ZTEST','1D', t0), 'oversold');
  check('a time between two candles uses the last one at-or-before it',
        jZoneAt('ZTEST','1D', t0 + 12*3600e3), 'oversold');
  check('a time on the middle candle reads middle', jZoneAt('ZTEST','1D', t1), 'middle');
  check('a time after the last candle still reads the last known zone',
        jZoneAt('ZTEST','1D', t2 + 999*3600e3), 'overbought');
  check('a time before any candle has nothing to reconstruct from, so null',
        jZoneAt('ZTEST','1D', t0 - 3600e3), null);
  check('a symbol with no stochastic data at all returns null, not a throw',
        jZoneAt('NOPE','1D', t1), null);
  check('a known symbol on a frame with no data also returns null',
        jZoneAt('ZTEST','1W', t1), null);
}

suite('jSizePlan — the real trade that exposed the old panel');
{
  // ZEC: entry 1139, invalidation 1124, risking $15. The user's actual size
  // was 1 coin; the old panel suggested 0.003-ish because it sized off a stale
  // account × percentage instead of the risk that was actually being taken.
  const p = jSizePlan(1139, 1124, 15, 1000);
  check('a 15-point stop risked at $15 is exactly one coin', p.size, 1);
  check('the stop distance is stated back', p.stop, 15);
  check('the risk is stated back, so a wrong one is visible', p.riskUsd, 15);
  check('notional is the position, not the risk', p.notional, 1139);
  near('the stop is reported as a percentage too', p.stopPct, 1.3169, 1e-3);
  near('leverage is notional over account', p.leverage, 1.139, 1e-9);
}

suite('jSizePlan — refusals rather than nonsense');
check('no stop distance means no plan', jSizePlan(1139, 1139, 15, 1000), null);
check('no risk means no plan', jSizePlan(1139, 1124, 0, 1000), null);
check('a negative risk is refused', jSizePlan(1139, 1124, -15, 1000), null);
check('an absent account leaves leverage unstated rather than invented',
      jSizePlan(1139, 1124, 15, 0).leverage, null);
check('a short sizes off the same distance, sign ignored',
      jSizePlan(1124, 1139, 15, 1000).size, 1);

suite('risk amount and percentage are two views of one setting');
check('1% of 1000 is $10', jRiskAmount(1000, 1), 10);
check('$15 of 1000 is 1.5%', jRiskPctOf(1000, 15), 1.5);
{
  const usd = jRiskAmount(2500, 0.6);
  check('the pair round-trips', jRiskPctOf(2500, usd), 0.6);
}
check('no account means no percentage rather than Infinity', jRiskPctOf(0, 15), null);

suite('jSuggestSize still honours its old contract, via the new path');
check('the original example is unchanged', jSuggestSize(100, 90, 1000, 1), 1);
check('and the ZEC case agrees when the percentage matches the dollars',
      jSuggestSize(1139, 1124, 1000, 1.5), 1);

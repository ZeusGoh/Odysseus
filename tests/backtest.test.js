/* backtest.test.js — the replay engine, the horizon labels, and the sign
   convention that has bitten this app twice.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['indicators.js', 'market-data.js', 'backtest.js']);
const {replayCrosses, summarise, frameBaseline, bucketEdge, spanLabel, spanShort,
       spanRange, barsLabel, HORIZONS, H_MAIN, FRAME_UNIT, TFS} = app;

// one bull cross on bar 5, one bear cross on bar 10, on a steadily rising tape
const K = [40,40,40,40,40,60,60,60,60,60,40,40,40,40,40,40,40,40,40,40];
const D = Array(20).fill(50);
const CLOSES = [100,100,100,100,100,100,101,102,103,104,105,106,107,107.1,108,109,110,111,112,113];
const CANDLES = CLOSES.map((c,i)=>({t:i*3600000, o:c, h:c, l:c, c}));

suite('horizons');
check('four horizons, short enough to matter', HORIZONS, [1,3,5,7]);
check('the headline horizon is one of them', HORIZONS.includes(H_MAIN), true);
check('every timeframe has a real-time unit',
      TFS.map(t=>t.key).filter(key=>!FRAME_UNIT[key]), []);

suite('spans — a bar is not the same amount of time on every frame');
check('7 bars on 4H is 28 hours', spanLabel('4H', 7), '28 hours');
check('1 bar on 1H is singular', spanLabel('1H', 1), '1 hour');
check('3 bars on the daily is 3 days', spanLabel('1D', 3), '3 days');
check('7 bars on the monthly is 7 months', spanLabel('1M', 7), '7 months');
check('the compact form drops the word', spanShort('4H', 3), '12h');
check('and stays compact on the monthly', spanShort('1M', 7), '7mo');
check('the whole set on 4H reads as a range', spanRange('4H'), '4–28 hours');
check('bar counts stay plain', [barsLabel(1), barsLabel(3)], ['1 bar','3 bars']);
check('an unknown frame degrades to bars rather than throwing',
      spanLabel('3M', 5), '5 bars');

suite('replayCrosses');
{
  const rows = replayCrosses(CANDLES, K, D, {});
  check('both crosses are scored', rows.map(r=>r.dir), ['bull','bear']);
  const bull = rows[0];
  check('entry is the close of the cross bar', bull.entry, 100);
  near('+1 bar', bull.rets[1], 1);
  near('+3 bars', bull.rets[3], 3);
  near('+5 bars', bull.rets[5], 5);
  near('+7 bars', bull.rets[7], 7);
  check('the zone the cross fired in is recorded', bull.zone, 'middle');
  check('divergence backing is a decided boolean', typeof bull.backed, 'boolean');

  // THE SIGN TRAP: on a bear call, + must mean price FELL.
  const bear = rows[1];
  const rawMove = (CLOSES[13] - CLOSES[10]) / CLOSES[10] * 100;
  ok('price actually rose after the bear cross', rawMove > 0);
  ok('so the bear cross scores negative', bear.rets[3] < 0);
  near('a bear return is exactly the price move flipped', bear.rets[3], -rawMove);
}
{
  const rows = replayCrosses(CANDLES, K, D, {liveBar: 15});
  check('a cross without 7 settled bars ahead of it is left unscored',
        rows.map(r=>r.dir), ['bull']);
  check('nothing is scored at all when the live bar is early',
        replayCrosses(CANDLES, K, D, {liveBar: 5}).length, 0);
}

suite('summarise');
{
  const rows = [
    {rets:{1:1,  3:2, 5:-3, 7:null}},
    {rets:{1:-1, 3:4, 5:3,  7:2}},
    {rets:{1:3,  3:0, 5:1,  7:4}},
  ];
  const s = summarise(rows);
  check('sample size is the number of signals', s.n, 3);
  near('median at +1 bar', s.byH[1].med, 1);
  check('win rate counts strictly positive moves', s.byH[3].win, 67);
  check('a flat move is not a win', s.byH[3].med, 2);
  check('nulls are dropped, not counted as zero', s.byH[7].n, 2);
  check('median of an even sample is the midpoint', s.byH[7].med, 3);
  check('an empty set summarises to nothing', summarise([]), null);
}

suite('edge against the frame');
{
  const rows = [{rets:{[H_MAIN]:-3}}, {rets:{[H_MAIN]:3}}, {rets:{[H_MAIN]:1}}];
  check('the baseline is the median ABSOLUTE move on that frame', frameBaseline(rows), 3);
  check('no data means no baseline', frameBaseline([]), null);
  check('a setup beating its frame scores above 1',
        bucketEdge({sum:{byH:{[H_MAIN]:{med:6}}}, baseline:3}), 2);
  check('and below 1 when it lags',
        bucketEdge({sum:{byH:{[H_MAIN]:{med:1.5}}}, baseline:3}), 0.5);
  check('a bucket with no baseline ranks last rather than crashing',
        bucketEdge({sum:{byH:{[H_MAIN]:{med:5}}}, baseline:null}), -Infinity);
}

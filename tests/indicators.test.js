/* indicators.test.js — the maths, on synthetic data with known answers.
   part of VL */
const {load} = require('./harness');
const app = load(['indicators.js']);
const {sma, stochastic, zoneOf, crossQuality, crossPoints, crossState, ema, emaRead, divergences, sideOf} = app;

suite('sma');
check('simple window', sma([1,2,3,4,5], 3), [null,null,2,3,4]);
check('shorter than the window is all null', sma([1,2], 3), [null,null]);
check('a null breaks the window and it restarts', sma([1,null,2,3,4], 2), [null,null,null,2.5,3.5]);

suite('stochastic (5,3,3)');
{
  const flat = Array(12).fill(10);
  const {k, d} = stochastic(flat, flat, flat, 5, 3, 3);
  check('a flat range reads 50, not NaN', k[11], 50);
  check('%D is defined once enough %K exists', d[11], 50);
  check('%K is null before the window fills', k[4], null);

  const rise = Array.from({length:12}, (_,i)=>100+i);
  const up = stochastic(rise, rise, rise, 5, 3, 3);
  check('closing at the top of the range reads 100', up.k[11], 100);

  const fall = Array.from({length:12}, (_,i)=>100-i);
  const dn = stochastic(fall, fall, fall, 5, 3, 3);
  check('closing at the bottom of the range reads 0', dn.k[11], 0);
}

suite('zones');
check('20 is still oversold', zoneOf(20), 'oversold');
check('just above 20 is middle', zoneOf(20.01), 'middle');
check('just below 80 is middle', zoneOf(79.99), 'middle');
check('80 is overbought', zoneOf(80), 'overbought');
ok('a bull cross from oversold is the strongest read',
   /strongest/.test(crossQuality('bull', 10).note));
ok('a bull cross from overbought is called stretched',
   /stretched/.test(crossQuality('bull', 90).note));

suite('crossPoints');
{
  const k = [40,40,40,40,40,60,60,60,60,60,40,40], d = Array(12).fill(50);
  const pts = crossPoints(k, d);
  check('one bull then one bear', pts.map(p=>p.dir), ['bull','bear']);
  check('the bull cross is on the bar it printed', pts[0].i, 5);
  check('its level is the midpoint of the two lines', pts[0].level, 55);
  check('the bear cross is on its own bar', pts[1].i, 10);
  check('nulls are skipped rather than read as zero',
        crossPoints([null,40,60], [null,50,50]).length, 1);
}

suite('crossState');
{
  const k = [40,40,40,40,40,60,60,60,60,60,40,40,40,40,40,40,40,40,40,40];
  const d = Array(20).fill(50);
  const s = crossState(k, d, 3, null, {});
  check('reports the last cross however old it is', s.type, 'bear');
  check('and how far back it printed', s.barsAgo, 9);
  check('nine bars back is not fresh on a 3-bar window', s.fresh, false);
  check('a cross on the live bar is provisional',
        crossState(k, d, 3, 10, {}).type, 'potential-bear');
  check('no cross at all reads flat',
        crossState([50,50,50,50,50], [40,40,40,40,40], 3, null, {}).type, 'flat');
}

suite('crossState — sitting at an extreme with no fresh cross is its own category');
{
  // an old bear cross nine bars back, but %K has since gone flat deep in
  // oversold — more useful to flag that than to keep reporting the old cross
  const kOS = [60,60,60,60,60, 15,15,15,15,15,15,15,15,15,15];
  const dOS = Array(15).fill(50);
  const wBull = crossState(kOS, dOS, 3, null, {});
  check('an oversold flat-line reads as a potential bull, not a stale bear',
        wBull.type, 'watch-bull');
  check('direction points at the reversal being watched for', wBull.dir, 'bull');
  check('carries the watching flag', wBull.watching, true);
  check('and the current %K level', wBull.level, 15);
  check('fresh is left unset rather than false, so the UI does not grey it out',
        wBull.fresh, undefined);

  // the mirror case: an old bull cross, now flat deep in overbought
  const kOB = [40,40,40,40,40, 85,85,85,85,85,85,85,85,85,85];
  const dOB = Array(15).fill(50);
  const wBear = crossState(kOB, dOB, 3, null, {});
  check('an overbought flat-line reads as a potential bear', wBear.type, 'watch-bear');
  check('direction points at the reversal being watched for', wBear.dir, 'bear');

  // never crossed at all in the loaded history, but already sitting at an extreme
  check('never having crossed does not suppress the zone watch (oversold)',
        crossState([15,15,15,15,15], [18,18,18,18,18], 3, null, {}).type, 'watch-bull');
  check('never having crossed does not suppress the zone watch (overbought)',
        crossState([85,85,85,85,85], [82,82,82,82,82], 3, null, {}).type, 'watch-bear');
}

suite('sideOf — zone-watch leans, but less than an actual nearing cross');
check('a potential-bull zone watch leans modestly long', sideOf({type:'watch-bull'}), 0.25);
check('a potential-bear zone watch leans modestly short', sideOf({type:'watch-bear'}), -0.25);
ok('weaker than a nearing cross in the same direction',
   sideOf({type:'watch-bull'}) < sideOf({type:'nearing-bull'}));

suite('EMA 200');
check('an EMA of a straight line is that line', ema([1,2,3,4,5], 3).slice(2), [2,3,4]);
check('too little history is all null', ema([1,2], 3), [null,null]);
{
  const short = emaRead(Array(50).fill(100));
  check('under 200 bars it says so rather than guessing', short.ok, false);
  const long = emaRead(Array.from({length:400}, (_,i)=>100+i));
  check('400 rising bars is a bullish regime', long.above, true);
  ok('and price is above the line by a positive distance', long.dist > 0);
}

suite('divergences');
{
  const flat = Array(60).fill(100);
  const {k, d} = stochastic(flat, flat, flat, 5, 3, 3);
  const out = divergences(k, d, flat, flat, {});
  ok('flat data produces no divergence and does not throw', Array.isArray(out) && out.length === 0);
}

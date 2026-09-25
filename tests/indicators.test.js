/* indicators.test.js — the maths, on synthetic data with known answers.
   part of Odysseus */
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

/*  Hand-built waves: %K is a triangle wave through given turning points and %D
    is %K one bar late, so the lines cross exactly at every turn. Price highs
    and lows are separate waves through the same turns, so the two shapes can
    be set independently — which is the whole question divergence asks.    */
function wave(points){
  const n = points[points.length-1][0]+1, out = new Array(n).fill(null);
  for(let p=1;p<points.length;p++){
    const [i0,v0] = points[p-1], [i1,v1] = points[p];
    for(let i=i0;i<=i1;i++) out[i] = v0 + (v1-v0)*((i-i0)/(i1-i0));
  }
  return out;
}
function lagged(k){ return k.map((v,i)=> i ? k[i-1] : v); }
const TURNS = [0,10,20,30,40,50];
const shape = (kLevels, lows, highs) => {
  const k = wave(TURNS.map((i,j)=>[i,kLevels[j]]));
  return { k, d: lagged(k), low: wave(TURNS.map((i,j)=>[i,lows[j]])), high: wave(TURNS.map((i,j)=>[i,highs[j]])) };
};

suite('divergences — the regular kind: price pushes on, the lines do not confirm');
{
  //                 idx: 0   10  20  30  40  50      troughs at 10 and 30, peaks at 20 and 40
  const f = shape([60,  8, 70, 20, 65, 30],       // %K: LOWER trough then HIGHER trough
                  [108,100,110, 96,110,100],      // price lows: 100 then 96 — a LOWER low
                  [110,102,112, 98,112,102]);
  const out = divergences(f.k, f.d, f.high, f.low, {});
  const bull = out.filter(x=>x.dir==='bull' && !x.hidden);
  check('a lower price low against a higher %K low is a regular bull divergence', bull.length, 1);
  check('drawn between the two troughs', [bull[0].points[0].kIdx, bull[0].points[1].kIdx], [10, 30]);
  ok('and it is not marked hidden', bull[0].hidden === false);
  check('no hidden divergence is claimed from the same shape', out.filter(x=>x.hidden).length, 0);
}

suite('divergences — the hidden kind: a pullback deeper on the lines than on price');
{
  const f = shape([60, 20, 70,  8, 65, 30],       // %K: 20 then 8 — a LOWER low on the lines
                  [108,100,110,104,110,100],      // price lows: 100 then 104 — a HIGHER low
                  [110,102,112,106,112,102]);
  const out = divergences(f.k, f.d, f.high, f.low, {});
  const hid = out.filter(x=>x.dir==='bull' && x.hidden);
  check('a higher price low against a lower %K low is a hidden bull divergence', hid.length, 1);
  check('between the same two troughs', [hid[0].points[0].kIdx, hid[0].points[1].kIdx], [10, 30]);
  ok('it argues for the bull side', hid[0].dir === 'bull');
  check('and is NOT reported as a regular bull divergence', out.filter(x=>x.dir==='bull' && !x.hidden).length, 0);
  ok('the record it leaves carries the flag every reader needs', out.every(x => typeof x.hidden === 'boolean'));
}

suite('divergences — hidden bearish is the mirror');
{
  const f = shape([40, 80, 30, 92, 35, 70],       // %K peaks: 80 then 92 — a HIGHER high on the lines
                  [ 98,110, 96,106, 97,104],
                  [100,112, 98,108, 99,106]);     // price highs: 112 then 108 — a LOWER high
  const out = divergences(f.k, f.d, f.high, f.low, {});
  const hid = out.filter(x=>x.dir==='bear' && x.hidden);
  check('a lower price high against a higher %K high is a hidden bear divergence', hid.length, 1);
  check('between the two peaks', [hid[0].points[0].kIdx, hid[0].points[1].kIdx], [10, 30]);
  check('and no regular bear divergence is claimed', out.filter(x=>x.dir==='bear' && !x.hidden).length, 0);
}

suite('divergences — price and lines moving the same way is neither kind');
{
  const f = shape([60, 20, 70,  8, 65, 30],       // lower %K low
                  [108,100,110, 96,110,100],      // AND a lower price low — just a downtrend
                  [110,102,112, 98,112,102]);
  const out = divergences(f.k, f.d, f.high, f.low, {});
  check('nothing is drawn', out.filter(x=>x.dir==='bull').length, 0);
  ok('and the hidden pass adds no rejects for a shape that was never hidden', !out.rejected.some(r=>r.hidden));
}

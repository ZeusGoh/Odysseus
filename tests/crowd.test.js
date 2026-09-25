/* crowd.test.js — the positioning read: who is crowded, who is trapped, what
   is fresh and what is a squeeze — and that every score is traceable.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['indicators.js','market-data.js','cloud.js','storage.js','state.js','backtest.js',
                   'btc-reference.js','verdict.js','news.js','crowd.js']);
const {crowdScore, crowdMetrics, crowdFundingRead, crowdRatioRead, crowdSeries, crowdSeriesTally,
       CROWD, CROWD_MIN_SCORE, CROWD_MIN_TURNOVER} = app;

// a calm, liquid coin: nothing crowded, nothing moving
const calm = over => Object.assign({
  chg24: 0.3, chg4: 0.1, fundingPct: 0.01, fundAvgPct: 0.01, ratio: 0.55, ratioAvg: 0.55,
  oiChg24: 0.5, oiChg4: 0.2, oiToTurnover: 0.6, turnover: 50e6,
}, over);

suite('crowdFundingRead / crowdRatioRead — the thresholds, in words');
check('cheap funding is no crowd', crowdFundingRead(0.01), {side:null, level:0});
check('longs paying 0.05 is a crowd', crowdFundingRead(0.05), {side:'long', level:1});
check('0.10 is an extreme one', crowdFundingRead(0.12), {side:'long', level:2});
check('shorts paying has a lower bar', crowdFundingRead(-0.03), {side:'short', level:1});
check('and its own extreme', crowdFundingRead(-0.08), {side:'short', level:2});
check('nothing given is no read', crowdFundingRead(null), {side:null, level:0});
check('55% long is the resting state of an alt, not a crowd', crowdRatioRead(0.55), {side:null, level:0});
check('65% long is', crowdRatioRead(0.66), {side:'long', level:1});
check('75% is extreme', crowdRatioRead(0.75), {side:'long', level:2});
check('40% long is a short crowd', crowdRatioRead(0.40), {side:'short', level:1});
check('32% is extreme', crowdRatioRead(0.30), {side:'short', level:2});

suite('crowdScore — nothing there is nothing, not a weak read');
check('a calm coin has no read', crowdScore(calm()), null);
check('a small nudge under the floor is still nothing', crowdScore(calm({oiChg24: 5.5})), null);   // coiled 4/4, cancels

suite('crowdScore — crowded longs lean bear, crowded shorts lean bull');
{
  const r = crowdScore(calm({fundingPct: 0.12, fundAvgPct: 0.04, ratio: 0.78, ratioAvg: 0.70}));
  check('the lean is against the crowd', r.dir, 'bear');
  check('kind is crowded, and the tag says who', [r.kind, r.tag, r.crowd], ['crowded', 'Crowded longs', 'long']);
  ok('every point has a line', r.why.some(w => /longs paying \+0\.120%\/8h/.test(w)) && r.why.some(w => /78% of accounts long/.test(w)));
  ok('funding climbing is called out against its average', r.why.some(w => /funding climbing/.test(w)));
  ok('and so is the crowd still piling in', r.why.includes('crowd still piling in'));
  check('extreme funding + extreme ratio + climbing + piling', r.score, 30 + 22 + 8 + 6);
  const s = crowdScore(calm({fundingPct: -0.09, ratio: 0.28}));
  check('the mirror: shorts paying, most accounts short — lean bull', [s.dir, s.tag, s.crowd], ['bull', 'Crowded shorts', 'short']);
  ok('worded from the short side', s.why.some(w => /72% of accounts short/.test(w)));
}

suite('crowdScore — a trapped crowd is fuel');
{
  const r = crowdScore(calm({fundingPct: 0.06, chg24: -4, oiChg24: 6}));
  check('longs paying, price down, OI up: bear', r.dir, 'bear');
  ok('and it says trapped', r.why.some(w => /^longs trapped: price -4\.0%, OI \+6\.0%/.test(w)));
  check('the trap line ranks first — it is the biggest single reason', r.why[0].startsWith('longs trapped'), true);
  const s = crowdScore(calm({fundingPct: -0.04, chg24: 5, oiChg24: 8}));
  check('shorts paying into a rising price: bull, trapped', [s.dir, s.why.some(w => /^shorts trapped/.test(w))], ['bull', true]);
}

suite('crowdScore — fresh money is the move being bought, cheaply');
{
  const r = crowdScore(calm({chg24: 4, oiChg24: 7, fundingPct: 0.015, ratio: 0.58}));
  check('price up, OI up, funding cheap, ratio sane: new longs', [r.dir, r.kind, r.tag], ['bull', 'fresh', 'New longs']);
  check('25 points, nothing arguing back', r.score, 25);
  const s = crowdScore(calm({chg24: -4, oiChg24: 7, fundingPct: -0.005, ratio: 0.5}));
  check('the mirror is new shorts', [s.dir, s.tag], ['bear', 'New shorts']);
  const c = crowdScore(calm({chg24: 4, oiChg24: 7, fundingPct: 0.08, ratio: 0.58}));
  check('the same move on expensive funding is NOT fresh — it is a crowd', [c.kind, c.dir], ['crowded', 'bear']);
}

suite('crowdScore — a squeeze is positions closing, and it is fragile');
{
  const r = crowdScore(calm({chg24: 5, oiChg24: -6}));
  check('rally on falling OI: lean bear, tagged as a squeeze', [r.dir, r.kind, r.tag], ['bear', 'squeeze', 'Short squeeze, fragile']);
  check('fourteen points — over the floor on its own, but a caution, not a call', r.score, 14);
  const f = crowdScore(calm({chg24: -5, oiChg24: -6, oiToTurnover: 2}));
  check('a flush with a heavy book, leaning bull, overhang added', [f.dir, f.tag, f.score], ['bull', 'Long flush, spent', 20]);
}

suite('crowdScore — the same OI cannot be both trapped longs and fresh shorts');
{
  const r = crowdScore(calm({fundingPct: 0.06, chg24: -4, oiChg24: 6}));
  ok('longs paying on a falling price with rising OI is a trap…', r.why.some(w => /^longs trapped/.test(w)));
  ok('…and is never also called fresh shorts', !r.why.some(w => /new shorts/.test(w)));
  const s = crowdScore(calm({fundingPct: 0.005, ratio: 0.5, chg24: -4, oiChg24: 6}));
  check('with no crowd on either side, the same tape IS fresh shorts', [s.kind, s.tag], ['fresh', 'New shorts']);
}

suite('crowdScore — coiled: OI loading on a flat price');
{
  const r = crowdScore(calm({chg24: 0.5, oiChg24: 9, fundingPct: 0.03, oiToTurnover: 2}));
  check('flat price, OI +9%, longs paying: bear, OI building', [r.dir, r.kind, r.tag], ['bear', 'coiled', 'OI building']);
  ok('the overhang is said', r.why.some(w => /OI 2\.0× daily turnover/.test(w)));
  const s = crowdScore(calm({chg24: 0.5, oiChg24: 9, fundingPct: -0.02, oiToTurnover: 2}));
  check('shorts paying flips it bull', s.dir, 'bull');
}

suite('crowdScore — a thin book cannot carry a crowd');
{
  const thick = crowdScore(calm({fundingPct: 0.12, ratio: 0.78}));
  const thin  = crowdScore(calm({fundingPct: 0.12, ratio: 0.78, turnover: 2e6}));
  check('the same read on a thin book scores 60%', thin.score, Math.round(thick.score * 0.6));
  ok('and says so', thin.why.includes('thin book'));
  check('the floor is what the file says', [CROWD_MIN_SCORE, CROWD_MIN_TURNOVER], [12, 5e6]);
}

suite('crowdScore — the other pile argues back');
{
  // shorts paying an extreme (bull 30) while a mild majority of accounts is long (bear 12);
  // averages set equal to now, so neither "climbing" nor "piling in" fires
  const r = crowdScore(calm({fundingPct: -0.09, fundAvgPct: -0.09, ratio: 0.67, ratioAvg: 0.67}));
  check('funding says short crowd, ratio says long crowd: the bigger pile wins', r.dir, 'bull');
  check('and the loser takes half its points back', r.score, 30 - 12 * 0.5);
  check('the crowd named is the one with the stronger read', r.crowd, 'short');
  const e = crowdScore(calm({fundingPct: -0.04, fundAvgPct: -0.04, ratio: 0.67, ratioAvg: 0.67}));
  check('at equal strength the two cancel to under the floor — no read, rather than a coin flip', e, null);
}

suite('crowdMetrics — the series into numbers, ascending in, percentages out');
{
  const t = {chg: 3.2, funding: 0.0004, oiVal: 120e6, turnover: 80e6};
  const oi = []; for(let i = 0; i <= 24; i++) oi.push({t: i, oi: 100 + i});          // 100 → 124
  const ratio = []; for(let i = 0; i < 24; i++) ratio.push({t: i, buy: 0.5 + i * 0.01}); // 0.50 → 0.73
  const fund = [0.0001, 0.0002, 0.0003, 0.0004];
  const kl = []; for(let i = 0; i <= 25; i++) kl.push({t: i, c: 100 + i});
  const m = crowdMetrics(t, oi, ratio, fund, kl);
  check('24h price from the ticker', m.chg24, 3.2);
  near('4h price from the candles', m.chg4, (125 - 121) / 121 * 100, 1e-9);
  check('funding as a percentage per 8h', m.fundingPct, 0.04);
  near('and its average', m.fundAvgPct, 0.025, 1e-9);
  near('OI 24h', m.oiChg24, 24, 1e-9);
  near('OI 4h', m.oiChg4, (124 - 120) / 120 * 100, 1e-9);
  near('the ratio now and its mean', m.ratio, 0.73, 1e-9);
  near('', m.ratioAvg, 0.615, 1e-9);
  check('OI against turnover', m.oiToTurnover, 1.5);
  const empty = crowdMetrics({chg: 1, funding: NaN, oiVal: NaN, turnover: 1e6}, [], [], [], []);
  check('missing series are nulls or zero, never a throw', [empty.oiChg24, empty.ratio, empty.fundAvgPct, empty.oiToTurnover], [0, null, null, null]);
  check('the thresholds object is exported for the row to colour against', typeof CROWD.fundLong, 'number');
}

/*  The terminal's week: the same read at every hour, and whether price then
    went that way. Built from synthetic hourly series so every number is
    known in advance.                                                     */
suite('crowdSeries — the read at every hour, from the 24 hours behind it');
{
  const H = 3600e3, T0 = Date.parse('2026-09-14T00:00:00Z');
  const N = 24 + 96;                                  // four days after the lookback: two flat, two climbing
  const kl = [], oi = [], ratio = [];
  for(let i = 0; i < N; i++){
    // price: flat for the first 48 hours, then climbs 0.5% an hour
    const c = i < 48 ? 100 : 100 * Math.pow(1.005, i - 47);
    kl.push({t: T0 + i*H, c});
    // OI: flat for the first 48 hours, then +1% an hour — so from hour 48 on it is fresh money
    oi.push({t: T0 + i*H, oi: i < 48 ? 1000 : 1000 * Math.pow(1.01, i - 47)});
    ratio.push({t: T0 + i*H, buy: 0.55});
  }
  const fund = [{t: T0 - 8*H, r: 0.0001}, {t: T0, r: 0.0001}, {t: T0 + 8*H, r: 0.0001}, {t: T0 + 16*H, r: 0.0001}, {t: T0 + 24*H, r: 0.0001}];
  const t = {oiVal: 60e6, turnover: 100e6};
  const s = crowdSeries(t, kl, oi, ratio, fund);
  check('one entry per hour past the lookback', s.length, N - 24);
  check('the first entry is hour 24', s[0].t, T0 + 24*H);
  check('a flat hour has no read', s[0].read, null);
  const late = s[s.length - 1];
  near('the last hour sees the full 24h climb', late.m.chg24, (Math.pow(1.005, 24) - 1) * 100, 1e-6);
  near('and the OI build', late.m.oiChg24, (Math.pow(1.01, 24) - 1) * 100, 1e-6);
  check('funding is read as a step — the last settlement at or before the hour', late.m.fundingPct, 0.01);
  check('which makes the last hour fresh money', [late.read && late.read.kind, late.read && late.read.dir], ['fresh', 'bull']);
  check('too few candles is an empty series, not a throw', crowdSeries(t, kl.slice(0, 10), oi, ratio, fund), []);

  const tally = crowdSeriesTally(s, 24);
  ok('hours with a read are counted', tally.n > 0);
  check('the last 24 hours have no look-ahead yet — open, not graded', tally.open, s.filter(x => x.read && x.t + 24*H > late.t).length);
  ok('the climbing hours that could be graded were right', tally.right > 0 && tally.wrong === 0);
  check('the rate is right over decided', tally.rate, 100);
  check('split by kind', Object.keys(tally.byKind), ['fresh']);
  ok('each graded entry carries its grade and the move', s.some(x => x.grade === 'right' && x.later > 0.5));
}

suite('crowdSeriesTally — the deadband, and a wrong lean');
{
  const H = 3600e3;
  const mk = (t, close, dir) => ({t, close, read: dir ? {dir, kind: 'crowded'} : null});
  const s = [mk(0, 100, 'bear'), mk(24*H, 102, null), mk(48*H, 100, 'bull'), mk(72*H, 100.3, null), mk(96*H, 50, 'bull')];
  const t = crowdSeriesTally(s, 24);
  check('a bear lean into a +2% move is wrong', s[0].grade, 'wrong');
  check('a bull lean into +0.3% is flat, under the deadband', s[2].grade, 'flat');
  check('the last one has nothing 24h on — open', [s[4].grade, t.open], [undefined, 1]);
  check('the tally', [t.n, t.right, t.wrong, t.flat, t.rate], [3, 0, 1, 1, 0]);
  check('no reads at all is an empty tally, not a throw', crowdSeriesTally([], 24).n, 0);
}

/*  The chart samples every band AT the candle, so a bar and the numbers
    under it are the same moment. cxStep is that sampling.               */
suite('cxStep — the latest sample at or before each bar');
{
  const ui = load(['indicators.js','market-data.js','cloud.js','storage.js','state.js','backtest.js',
                   'btc-reference.js','verdict.js','news.js','crowd.js','ui-crowd.js']);
  const H = 3600e3;
  const kl = [0, 4, 8, 12, 16].map(h => ({t: h*H}));
  const fund = [{t: 0, v: 1}, {t: 8*H, v: 2}, {t: 16*H, v: 3}];          // settles every 8h
  check('a bar takes the rate in force when it opened', ui.cxStep(kl, fund, 0), [1, 1, 2, 2, 3]);
  const oi = [{t: 1*H, v: 10}, {t: 5*H, v: 20}, {t: 9*H, v: 30}];            // prints an hour into each bar
  check('with a tolerance of the bar span, the print inside the bar counts', ui.cxStep(kl, oi, 4*H - 1), [10, 20, 30, 30, 30]);
  check('before the first sample is null, not zero', ui.cxStep(kl, [{t: 10*H, v: 5}], 0), [null, null, null, 5, 5]);
  check('no samples is all null', ui.cxStep(kl, [], 0), [null, null, null, null, null]);
}

/* score.test.js — settling analyst calls against real price, later.

   The mechanics (scorePriceAt, scoreCovers) mirror js/anomalies.js's own
   anomPriceAt/anomCovers, already proven there; what is new and worth pinning
   here is the CALL grading (right/wrong/flat, sign convention), never
   rewriting a settled checkpoint, and the digest staying a pure function of
   whatever records it is handed — since a digest built from the wrong
   analyst's records is exactly the leak the two-process split exists to
   prevent.
   part of Odysseus */

const path = require('path');
const MCP = path.join(__dirname, '..', 'mcp');
const {
  scorePriceAt, scoreCovers, callGrade, settleRecord, scoreDigest,
  scoreExcursion, scoreLiveMark, scoreIsOpen, scoreNextCheck,
  scoreBrief, scoreDescribe, scoreFrameOf, scoreMissShape, scoreHorizonMark, scoreRecordMark, scoreTally, scoreExtremes, scoreStampTime, settleAll, readTrack, writeTrack,
  DEADBAND_PCT, MIN_FOR_DIGEST, HOUR, SCORE_CHECKS, SCORE_EXTREMES, SCORE_STAMP_SLACK_MS, SCORE_STAMP_MAX_MS,
} = require(path.join(MCP, 'score.js'));

const BASE = Date.parse('2026-09-01T00:00:00.000Z');

// n hourly bars starting at BASE; close price from closeFn(i), default flat
function bars(n, closeFn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = closeFn ? closeFn(i) : 100;
    out.push({ t: BASE + i * HOUR, o: c, h: c, l: c, c, v: 1 });
  }
  return out;
}

suite('scorePriceAt — a bar stamped t has not settled until t+1h');
{
  const b = bars(5, i => 100 + i);
  check('nothing has settled before the first bar closes', scorePriceAt(b, BASE), null);
  check('the first bar settles exactly one hour later', scorePriceAt(b, BASE + HOUR), 100);
  check('a moment before it settles, it still does not count', scorePriceAt(b, BASE + HOUR - 1), null);
  check('three hours in, the third bar has settled', scorePriceAt(b, BASE + 3 * HOUR), 102);
}

suite('scoreCovers — pending, expired, ok and missing are four different answers');
{
  const b = bars(5);
  check('past the end of the data is pending', scoreCovers(b, BASE + 10 * HOUR), 'pending');
  check('before the start of the data is expired', scoreCovers(b, BASE - 10 * HOUR), 'expired');
  check('inside the window is fine', scoreCovers(b, BASE + 2 * HOUR), 'ok');
  check('no bars at all is missing', scoreCovers([], BASE), 'missing');
  check('null is missing too', scoreCovers(null, BASE), 'missing');
}

suite('callGrade — sign convention: right always means the call would have paid');
check('a bull call on a rise past the deadband is right', callGrade('bull', 2), 'right');
check('a bull call on a fall past the deadband is wrong', callGrade('bull', -2), 'wrong');
check('a bear call on a fall past the deadband is right', callGrade('bear', -2), 'right');
check('a bear call on a rise past the deadband is wrong', callGrade('bear', 2), 'wrong');
check('a move inside the deadband is flat, not a call', callGrade('bull', 0.1), 'flat');
check('exactly on the deadband edge is still flat', callGrade('bull', DEADBAND_PCT), 'flat');
check('a neutral call has nothing to grade', callGrade('neutral', 5), null);
check('an unrecognised call has nothing to grade', callGrade('sideways', 5), null);
check('no price move means nothing to grade', callGrade('bull', null), null);
check('a non-finite move means nothing to grade', callGrade('bull', NaN), null);

suite('settleRecord — fills what is due, leaves the rest alone');
{
  // generatedAt sits 2 hours into the series, so a settled entry price exists
  // before it — the same shape a real fetch produces (history predates the
  // report, it is never exactly bar-aligned with it).
  const GEN = new Date(BASE + 2 * HOUR).toISOString();
  const priceBars = bars(200, i => 100 + i * 0.1);   // a slow, steady rise

  const freshRecord = () => ({ call: 'bull', generatedAt: GEN, checks: {} });

  {
    const r = freshRecord();
    const filled = settleRecord(r, priceBars, BASE + 1 * HOUR); // nothing due yet
    check('nothing is due one hour in', filled, 0);
    check('checks stays empty', Object.keys(r.checks).length, 0);
  }

  {
    const r = freshRecord();
    const filled = settleRecord(r, priceBars, BASE + 30 * HOUR); // past the 24h line
    check('the 24h checkpoint fills', filled, 1);
    check('a steady rise grades a bull call right', r.checks['24'].grade, 'right');
    check('the 72h and 168h checkpoints are not due yet', !r.checks['72'] && !r.checks['168'], true);
  }

  {
    // a bear call against the same rising price should grade wrong
    const r = Object.assign(freshRecord(), { call: 'bear' });
    settleRecord(r, priceBars, BASE + 30 * HOUR);
    check('the same rise grades a bear call wrong', r.checks['24'].grade, 'wrong');
  }

  {
    // settling twice must never rewrite an already-settled checkpoint
    const r = freshRecord();
    settleRecord(r, priceBars, BASE + 30 * HOUR);
    const firstPct = r.checks['24'].pct;
    const wrongBars = bars(200, i => 100 - i * 5);   // wildly different data
    const filledAgain = settleRecord(r, wrongBars, BASE + 40 * HOUR);
    check('re-settling touches only what is newly due', filledAgain, 0);
    check('the 24h result is unchanged by the second call', r.checks['24'].pct, firstPct);
  }

  {
    // history that does not reach back to generatedAt cannot price the entry
    const r = freshRecord();
    const lateBars = bars(50, i => 100).map(b => Object.assign({}, b, { t: b.t + 100 * HOUR }));
    settleRecord(r, lateBars, BASE + 200 * HOUR);
    check('an uncoverable entry settles as expired, not guessed at', r.checks['24'].state, 'expired');
  }

  {
    // due by the clock, but the fetched bars themselves do not reach that far —
    // must stay unsettled so the next pass, with fresher data, can retry it
    const r = freshRecord();
    const shortBars = bars(10, i => 100 + i * 0.1); // only 10 hours of history
    const filled = settleRecord(r, shortBars, BASE + 100 * HOUR);
    check('a checkpoint the fetched bars cannot reach is left for next time', filled, 0);
    check('and is not marked expired either', r.checks['24'], undefined);
  }
}

suite('settleRecord — four marks, and each one keeps the whole story');
{
  check('one day, two, three, a week', SCORE_CHECKS, [24, 48, 72, 168]);
  const GEN = new Date(BASE + 2 * HOUR).toISOString();
  // a rise that overshoots to +6% at hour 10 then settles back to +2% at hour 26;
  // highs and lows ride 0.5 above and below the close
  const wavy = bars(300, i => i >= 10 && i < 14 ? 106 : i >= 26 ? 102 : 100 + i * 0.2)
    .map(b => Object.assign({}, b, { h: b.c + 0.5, l: b.c - 0.5 }));
  const r = { call: 'bull', generatedAt: GEN, checks: {} };
  settleRecord(r, wavy, BASE + 60 * HOUR);
  ok('24h and 48h both fill by hour 60', !!r.checks['24'] && !!r.checks['48']);
  ok('72h does not', !r.checks['72']);
  check('the entry is the settled close before the call', r.checks['24'].entry, 100.2);
  ok('the exit is the price at the mark', r.checks['24'].exit > 100 && r.checks['24'].pct > 0);
  ok('the run-up on the way is remembered, not just the finish',
     r.checks['24'].maxUp > r.checks['24'].pct && r.checks['24'].maxUp >= 6);
  ok('and the worst dip, never above zero', r.checks['24'].maxDown <= 0);
  check('the old fields are exactly as before', typeof r.checks['24'].grade, 'string');
}

suite('scoreExcursion — best and worst the call ever looked in a window');
{
  const b = bars(10, i => 100).map((x, i) => Object.assign({}, x, { h: i === 4 ? 110 : 100, l: i === 6 ? 90 : 100 }));
  const e = scoreExcursion(b, 100, BASE + 1 * HOUR, BASE + 9 * HOUR);
  check('the spike up is caught', e.maxUp, 10);
  check('and the spike down', e.maxDown, -10);
  const narrow = scoreExcursion(b, 100, BASE + 1 * HOUR, BASE + 4 * HOUR);
  check('a window that ends before the spike does not see it', narrow.maxUp, 0);
  check('nothing has closed yet is null', scoreExcursion(b, 100, BASE + 20 * HOUR, null), null);
  check('no entry is null', scoreExcursion(b, 0, BASE, null), null);
  const open = scoreExcursion(b, 100, BASE + 1 * HOUR, null);
  check('an open-ended window runs to the last bar', open.bars, 9);
}

suite('scoreLiveMark — where an open call stands right now');
{
  const GEN = new Date(BASE + 2 * HOUR).toISOString();
  const b = bars(12, i => 100 + i).map(x => Object.assign({}, x, { h: x.c + 1, l: x.c - 1 }));
  const m = scoreLiveMark({ call: 'bull', generatedAt: GEN }, b, BASE + 12 * HOUR);
  check('entry is the settled close before the call', m.entry, 101);
  check('price is the LAST bar, live, not the last settled one', m.price, 111);
  near('the move so far', m.pct, (111 - 101) / 101 * 100, 0.01);
  check('graded so far', m.grade, 'right');
  check('hours in', m.hoursIn, 10);
  ok('excursion rides along', m.maxUp > 0 && m.maxDown <= 0);
  check('bars that cannot price the entry give nothing', scoreLiveMark({ call: 'bull', generatedAt: GEN }, [], BASE + 12 * HOUR), null);
  check('a neutral call is marked but not graded', scoreLiveMark({ call: 'neutral', generatedAt: GEN }, b, BASE + 12 * HOUR).grade, null);
}

suite('scoreIsOpen / scoreNextCheck — a call is open until every mark is in');
{
  const GEN = '2026-09-01T00:00:00.000Z', GEN_MS = Date.parse(GEN);
  ok('nothing settled is open', scoreIsOpen({ generatedAt: GEN, checks: {} }));
  ok('three of four is still open', scoreIsOpen({ generatedAt: GEN, checks: { 24: {}, 48: {}, 72: {} } }));
  ok('all four is closed', !scoreIsOpen({ generatedAt: GEN, checks: { 24: {}, 48: {}, 72: {}, 168: {} } }));
  ok('an expired mark counts as settled', !scoreIsOpen({ generatedAt: GEN, checks: { 24: { state: 'expired' }, 48: {}, 72: {}, 168: {} } }));
  const n = scoreNextCheck({ generatedAt: GEN, checks: { 24: {} } }, GEN_MS + 30 * HOUR);
  check('the next mark is the first unsettled one', n.hours, 48);
  check('with when it lands', n.dueAt, GEN_MS + 48 * HOUR);
  ok('and whether that has already passed', n.due === false);
  ok('a due one says so', scoreNextCheck({ generatedAt: GEN, checks: {} }, GEN_MS + 30 * HOUR).due === true);
  check('nothing left is null', scoreNextCheck({ generatedAt: GEN, checks: { 24: {}, 48: {}, 72: {}, 168: {} } }, GEN_MS), null);
}

suite('scoreDigest — a pure function of whatever records it is handed');
{
  const rec = (symbol, call, grade, pct) => ({
    symbol, call, generatedAt: '2026-09-10T00:00:00.000Z',
    checks: { '24': { pct, grade } },
  });

  check('too few settled calls says so rather than a misleading rate',
    scoreDigest([rec('SOL', 'bull', 'right', 2)], 24).count < MIN_FOR_DIGEST, true);
  ok('and the text says "too few"', /too few/.test(scoreDigest([rec('SOL', 'bull', 'right', 2)], 24).text));
  ok('nothing settled at all says so too', /No settled/.test(scoreDigest([], 24).text));

  const many = [
    rec('SOL', 'bull', 'right', 2), rec('ETH', 'bull', 'right', 3),
    rec('ARB', 'bear', 'right', -2), rec('DOGE', 'bull', 'right', 4),
    rec('XRP', 'bull', 'wrong', -1.5), rec('LINK', 'bull', 'flat', 0.1),
  ];
  const d = scoreDigest(many, 24);
  check('right calls are counted', d.rightCount, 4);
  check('wrong calls are counted', d.wrongCount, 1);
  check('flat calls are counted separately, not folded into right or wrong', d.flatCount, 1);
  check('the rate is over decided calls only, not flat ones', d.rate, 80);
  ok('a recent miss is named in the text', d.text.includes('XRP bull'));

  // records that are not yet settled at this checkpoint are excluded, not
  // silently treated as flat
  const withUnsettled = many.concat([{ symbol: 'BTC', call: 'bull', generatedAt: '2026-09-11T00:00:00.000Z', checks: {} }]);
  check('an unsettled record does not inflate the count', scoreDigest(withUnsettled, 24).count, many.length);
}

suite('scoreDescribe — what a call was about, read off the analyst\'s own block');
{
  const st = scoreDescribe('stoch', { call: 'bull', horizon: '4H, next 20 hours',
    for: ['71% of 42 past 4H bull crosses from oversold'], keyNumbers: { bestSetup: '4H bull cross from oversold — strong' } });
  check('a stoch call is tagged by frame and direction', st.setup, '4H bull');
  check('the horizon is kept', st.horizon, '4H, next 20 hours');
  check('and the first stated reason', st.claim, '71% of 42 past 4H bull crosses from oversold');
  check('the frame falls back to the horizon when bestSetup has none',
        scoreDescribe('stoch', { call: 'bear', horizon: '1D, next 5 days', keyNumbers: {} }).setup, '1D bear');
  check('no frame anywhere is still a tag, not a throw', scoreDescribe('stoch', { call: 'bull' }).setup, '? bull');
  check('1H is not mistaken for 1H inside "21H"', scoreFrameOf('next 21Hours'), null);

  const nw = scoreDescribe('news', { call: 'bull', keyNumbers: { classification: 'spec' }, catalyst: { found: true } });
  check('a news call is tagged by classification and catalyst', nw.setup, 'spec + catalyst');
  check('a spec call with nothing found says so', scoreDescribe('news', { keyNumbers: { classification: 'spec' }, catalyst: { found: false } }).setup, 'spec, no catalyst');
  const cr = scoreDescribe('crowd', { call: 'bear', horizon: 'next 24 hours', keyNumbers: { crowdTag: 'Crowded longs', crowdedSide: 'long' } });
  check('a crowd call is keyed by the read it acted on and the way it called it', cr.setup, 'crowded longs → bear');
  check('and its mark comes from its horizon', cr.mark, 24);
  check('no tag falls back to which side was crowded', scoreDescribe('crowd', { call: 'bull', keyNumbers: { crowdedSide: 'short' } }).setup, 'crowded short → bull');
  check('and no read at all says so', scoreDescribe('crowd', { call: 'neutral', keyNumbers: {} }).setup, 'no read → neutral');
  check('a market-wide call is just that', scoreDescribe('news', { keyNumbers: { classification: 'mkt' } }).setup, 'mkt');
  check('garbage in is a tag out, not a throw', scoreDescribe('news', null).setup, '?');
}

suite('scoreMissShape — early is a different mistake from wrong');
{
  check('a bull that ran +3% before closing red worked for a while',
        scoreMissShape('bull', { pct: -2, grade: 'wrong', maxUp: 3, maxDown: -2.5 }), 'worked for a while (+3% at best) then reversed');
  check('a bull that never printed green never went your way',
        scoreMissShape('bull', { pct: -2, grade: 'wrong', maxUp: 0.3, maxDown: -2.5 }), 'never went your way');
  check('a bear reads the excursion the other way round',
        scoreMissShape('bear', { pct: 2, grade: 'wrong', maxUp: 2.5, maxDown: -3 }), 'worked for a while (-3% at best) then reversed');
  check('no excursion kept means no shape', scoreMissShape('bull', { pct: -2, grade: 'wrong' }), null);
}

suite('scoreBrief — one analyst\'s own record, shaped so it can learn from it');
{
  const NOW = Date.parse('2026-09-20T00:00:00.000Z');
  let n = 0;
  const rec = (symbol, call, conviction, setup, checks, hoursAgo) => ({
    id: 'r' + (++n), symbol, call, conviction, setup, claim: 'because ' + symbol,
    generatedAt: new Date(NOW - (hoursAgo || 48 + n) * HOUR).toISOString(), checks: checks || {},
  });
  const c24 = (pct, extra) => ({ '24': Object.assign({ pct, grade: callGrade('bull', pct) }, extra || {}) });

  check('no records at all says so', scoreBrief([], { symbol: 'SOL', now: NOW }).text, 'You have no track record yet.');
  ok('calls with nothing settled yet say how many are waiting',
     /made 2 call\(s\); none has reached/.test(scoreBrief([rec('SOL', 'bull', 60), rec('ETH', 'bear', 50)], { now: NOW }).text));

  // under the floor: facts shown, rates withheld
  const few = [rec('SOL', 'bull', 70, '4H bull', c24(2)), rec('ETH', 'bull', 70, '4H bull', c24(-2)), rec('ARB', 'bull', 30, '1D bull', c24(3))];
  const f = scoreBrief(few, { symbol: 'SOL', now: NOW });
  check('two decided calls is not a rate', f.overall['24'].rate, null);
  ok('and the text says so rather than printing 67%', /too few decided/.test(f.text) && !/67%/.test(f.text));
  ok('but the miss is still named, with what was said', /Miss: ETH bull at 70/.test(f.text) && /You said: "because ETH"/.test(f.text));
  check('this coin\'s last call is a fact, shown regardless', f.onThisCoin.lastCall.call, 'bull');
  ok('with how it went', /On SOL: you called bull at 70 .* 24h \+2% right/.test(f.text));

  // over the floor: the three splits
  const many = [
    rec('SOL', 'bull', 80, '4H bull', c24(2)), rec('ETH', 'bull', 75, '4H bull', c24(-2, { maxUp: 0.2, maxDown: -2.5 })),
    rec('ARB', 'bull', 72, '1D bull', c24(-3, { maxUp: 2.8, maxDown: -3.2 })), rec('DOGE', 'bull', 90, '4H bull', c24(-1)),
    rec('XRP', 'bear', 40, '4H bear', { '24': { pct: -2, grade: 'right' } }), rec('LINK', 'bear', 45, '4H bear', { '24': { pct: -3, grade: 'right' } }),
    rec('SUI', 'bear', 45, '1D bear', { '24': { pct: -1, grade: 'right' } }), rec('OP', 'bear', 30, '4H bear', { '24': { pct: 1, grade: 'wrong' } }),
    rec('NEAR', 'bull', 50, '4H bull', c24(4)), rec('TIA', 'bull', 55, '1D bull', c24(1)),
    rec('SOL', 'neutral', 20, '4H neutral', {}, 3),           // the newest SOL call, neutral, not graded
    rec('BTC', 'bull', 60, '1D bull', {}, 5),                  // open
    rec('AVAX', 'bull', 85, '4H bull', c24(-2)),               // oldest: a fifth high-conviction call
  ];
  const b = scoreBrief(many, { symbol: 'SOL', now: NOW });
  check('a neutral call is counted but never graded', [b.calls, b.graded], [13, 12]);
  check('overall at 24h over decided calls', [b.overall['24'].right, b.overall['24'].wrong, b.overall['24'].rate], [6, 5, 55]);
  check('the open call is waiting, not wrong', b.overall['24'].pending, 1);
  check('split by direction', [b.byCall.bull.rate, b.byCall.bear.rate], [43, null]);
  ok('bear has four decided — one short of a rate, and says so', /fewer than 5/.test(b.byCall.bear.note));
  check('split by conviction: the 70+ calls', [b.byConviction['high (70+)'].right, b.byConviction['high (70+)'].wrong, b.byConviction['high (70+)'].rate], [1, 4, 20]);
  check('against the 40-69 calls', b.byConviction['mid (40-69)'].rate, 100);
  ok('the calibration warning fires when high conviction has not outperformed',
     /high-conviction calls have not been more right/.test(b.text));
  check('split by setup', Object.keys(b.bySetup).sort(), ['1D bear', '1D bull', '4H bear', '4H bull']);
  check('4H bull specifically', [b.bySetup['4H bull'].right, b.bySetup['4H bull'].wrong], [2, 3]);
  check('this coin: the newest call is shown even when neutral', b.onThisCoin.lastCall.call, 'neutral');
  check('and it is open', b.onThisCoin.lastCall.open, true);
  check('misses are newest first and carry their shape', b.recentMisses.map(m => m.symbol), ['ETH', 'ARB', 'DOGE', 'OP']);
  check('a miss that ran the right way first says so', b.recentMisses[1].shape, 'worked for a while (+2.8% at best) then reversed');
  check('one that never did says that', b.recentMisses[0].shape, 'never went your way');
  ok('the standing guidance travels with it', /pattern to notice/.test(b.note));

  // the live mark for an open call on this coin, when bars are handed in
  const open = [rec('SOL', 'bull', 60, '4H bull', {}, 6)];
  const liveBars = []; for (let i = 0; i < 10; i++) liveBars.push({ t: NOW - (10 - i) * HOUR, o: 100, h: 101 + i, l: 99, c: 100 + i, v: 1 });
  const lv = scoreBrief(open, { symbol: 'SOL', now: NOW, bars: liveBars });
  ok('an open call on this coin gets a live reading', lv.onThisCoin.lastCall.live && lv.onThisCoin.lastCall.live.pct > 0);
  ok('and the text says where it stands so far', /now \+.*right so far/.test(lv.text));

  // blindness: it is a function of the records it is handed and nothing else
  const stochOnly = scoreBrief([rec('SOL', 'bull', 70, '4H bull', c24(2))], { symbol: 'SOL', now: NOW });
  ok('nothing in a brief names the other side', !/news/i.test(JSON.stringify(stochOnly)));
}

suite('scoreHorizonMark — a call is graded at the mark its own horizon named');
check('"next 20 hours" is a 24h call', scoreHorizonMark('4H, next 20 hours'), 24);
check('"next 24-48 hours" reads the far end', scoreHorizonMark('next 24-48 hours'), 48);
check('"next 3 days" is 72h', scoreHorizonMark('next 3 days'), 72);
check('"1D, next 5-7 days" is a weekly call', scoreHorizonMark('1D, next 5-7 days'), 168);
check('two weeks is capped at the last mark', scoreHorizonMark('2 weeks'), 168);
check('"24h" with the bare unit works', scoreHorizonMark('24h'), 24);
check('no span: the frame decides — 1D reads at 72h', scoreHorizonMark('the daily', '1D bull cross'), 72);
check('no span: a weekly frame reads at the week', scoreHorizonMark('1W'), 168);
check('nothing at all is the first mark', scoreHorizonMark(''), 24);
check('the frame inside the horizon is not mistaken for a span ("1D" is not one day of horizon)', scoreHorizonMark('1D, next 5 days'), 168);
check('scoreDescribe carries the mark onto the record', scoreDescribe('stoch', { call: 'bull', horizon: '1D, next 5 days' }).mark, 168);
check('and the analyst\'s own record note', scoreDescribe('news', { call: 'bull', recordNote: ' cut to 40 ' }).recordNote, 'cut to 40');
check('a record without a mark reads at the first one', scoreRecordMark({ checks: {} }), 24);
check('a record with one reads there', scoreRecordMark({ mark: 72, checks: {} }), 72);

suite('settleRecord — the baseline: the same call net of what BTC did');
{
  const coin = bars(30, i => 100 + i);              // +1/h
  const btc = bars(30, i => 1000 + i * 15);         // +1.5%/h — the market did more
  const r = { symbol: 'SOL', generatedAt: new Date(BASE + HOUR).toISOString(), call: 'bull', checks: {} };
  settleRecord(r, coin, BASE + 27 * HOUR, btc);
  const c = r.checks['24'];
  check('the coin\'s own move is graded as before', c.grade, 'right');
  near('BTC\'s move over the same window is kept', c.btcPct, (1000 + 15 * 24) / (1000) * 100 - 100, 0.01);
  ok('the net move is negative — the coin lagged the market', c.vsBtc < 0);
  check('so net of BTC the bull call was wrong', c.gradeVsBtc, 'wrong');
  const b = { symbol: 'BTC', generatedAt: new Date(BASE + HOUR).toISOString(), call: 'bull', checks: {} };
  settleRecord(b, btc, BASE + 27 * HOUR, btc);
  check('BTC itself gets no baseline', 'gradeVsBtc' in b.checks['24'], false);
  const nb = { symbol: 'SOL', generatedAt: new Date(BASE + HOUR).toISOString(), call: 'bull', checks: {} };
  settleRecord(nb, coin, BASE + 27 * HOUR);
  check('no BTC bars handed in: settled as before, no baseline fields', 'btcPct' in nb.checks['24'], false);
  check('scoreTally can read the baseline grade', scoreTally([r], 24, 'gradeVsBtc').wrong, 1);
  check('and treats a checkpoint with no baseline as pending on that field', scoreTally([nb], 24, 'gradeVsBtc').pending, 1);
}

suite('scoreBrief — own marks, the market, and hedging');
{
  const NOW = Date.parse('2026-09-20T00:00:00.000Z');
  let n = 0;
  const rec = (symbol, call, conviction, mark, checks, extra) => Object.assign({
    id: 'r' + (++n), symbol, call, conviction, setup: '4H ' + call, mark,
    generatedAt: new Date(NOW - (48 + n) * HOUR).toISOString(), checks: checks || {},
  }, extra || {});
  // a weekly call that was wrong at 24h and right at 168h
  const weekly = rec('SOL', 'bull', 60, 168, { '24': { pct: -2, grade: 'wrong' }, '168': { pct: 5, grade: 'right' } });
  const b1 = scoreBrief([weekly], { symbol: 'SOL', now: NOW });
  check('read at its own mark, the weekly call is right', b1.overall.own.right, 1);
  check('while the fixed 24h mark still says wrong — that is the person\'s view, not the analyst\'s', b1.overall['24'].wrong, 1);
  check('and it is not a miss', b1.recentMisses.length, 0);
  ok('the text says the calls are read at their own horizon', /mark its own horizon named/.test(b1.text));

  // rights that were only the market
  const mk = i => rec('C' + i, 'bull', 60, 24, { '24': { pct: 3, grade: 'right', btcPct: 4, vsBtc: -1, gradeVsBtc: 'wrong' } });
  const real = i => rec('D' + i, 'bull', 60, 24, { '24': { pct: 3, grade: 'right', btcPct: 0.5, vsBtc: 2.5, gradeVsBtc: 'right' } });
  const b2 = scoreBrief([mk(1), mk(2), mk(3), mk(4), real(5), real(6)], { now: NOW });
  check('on the move, six of six', b2.overall.own.rate, 100);
  check('net of BTC, two of six', [b2.vsMarket.right, b2.vsMarket.wrong, b2.vsMarket.rate], [2, 4, 33]);
  check('and the count of rights that were only the market', b2.marketOnly, 4);
  ok('said out loud', /4 of your right calls did not beat BTC/.test(b2.text));
  ok('the split by horizon is there', /By horizon: 24h 100% of 6/.test(b2.text));

  // hedging
  const neutrals = [];
  for (let i = 0; i < 4; i++) neutrals.push(rec('N' + i, 'neutral', 20, 24, {}));
  const b3 = scoreBrief(neutrals.concat([real(9), real(10)]), { now: NOW });
  check('neutral share is counted over every kind of call', [b3.hedging.neutral, b3.hedging.ofLast, b3.hedging.pct], [4, 6, 67]);
  ok('and past the share it is said out loud', b3.hedging.warn && /called neutral on 4 of your last 6/.test(b3.text));
  const b4 = scoreBrief([rec('N1', 'neutral', 20, 24, {}), real(11), real(12), real(13), real(14)], { now: NOW });
  check('one neutral in five is not hedging', b4.hedging.warn, false);

  // a miss carries what BTC did, and any post-mortem written onto it
  const miss = rec('ETH', 'bull', 70, 24, { '24': { pct: -3, grade: 'wrong', btcPct: 1.2, vsBtc: -4.2, gradeVsBtc: 'wrong' } },
                   { postmortem: { text: 'An unlock landed that morning.', at: 'x' } });
  const b5 = scoreBrief([miss], { now: NOW });
  check('the miss carries the market\'s move', b5.recentMisses[0].btcPct, 1.2);
  check('and the post-mortem', b5.recentMisses[0].postmortem, 'An unlock landed that morning.');
  ok('both are in the words', /BTC did \+1\.2% meanwhile/.test(b5.text) && /What actually happened: An unlock/.test(b5.text));
  // and the note the analyst wrote last time on this coin comes back to it
  const noted = rec('SOL', 'bull', 60, 24, {}, { recordNote: 'cut from 70 to 60 — 4H bulls are 2 of 6' });
  ok('what it wrote last time on this coin is shown back', /Last time you wrote: "cut from 70 to 60/.test(scoreBrief([noted], { symbol: 'SOL', now: NOW }).text));
}


/*  The record's two ends — best and worst ever, net of the market, across
    every coin. Symmetric on purpose: the best is never handed over alone. */
suite('scoreExtremes — the best and the worst call, net of the market, across every coin');
{
  const NOW = Date.parse('2026-09-20T00:00:00.000Z');
  let n = 0;
  const rec = (symbol, call, mark, c, extra) => Object.assign({
    id: 'e' + (++n), symbol, call, conviction: 60, setup: 'x', mark,
    generatedAt: new Date(NOW - (400 + n) * HOUR).toISOString(),   // old — outside the recent window on purpose
    checks: { [String(mark)]: c },
  }, extra || {});
  const rows = [
    rec('SOL', 'bull', 24,  { pct: 8,  grade: 'right', btcPct: 1,  vsBtc: 7 }),     // +7 net
    rec('ETH', 'bear', 24,  { pct: -5, grade: 'right', btcPct: -1, vsBtc: -4 }),    // bear: -(-4) = +4 net
    rec('BTC', 'bull', 168, { pct: 2,  grade: 'right' }),                           // no baseline: raw +2
    rec('DOGE','bull', 24,  { pct: 0.2, grade: 'flat', btcPct: 0.1, vsBtc: 0.1 }),  // +0.1 — flat still ranks
    rec('ADA', 'bear', 48,  { pct: 6,  grade: 'wrong', btcPct: 1,  vsBtc: 5 }),     // bear: -5 net
    rec('XRP', 'bull', 24,  { pct: -9, grade: 'wrong', btcPct: -2, vsBtc: -7 }),    // -7 net
    rec('NEAR','bull', 24,  { pct: 1,  grade: undefined }),                         // unsettled — never ranked
    rec('SUI', 'neutral', 24, { pct: 4, grade: 'right' }),                          // neutral — never ranked
  ];
  const e = scoreExtremes(rows);
  check('three each by default', [e.best.length, e.worst.length, SCORE_EXTREMES], [3, 3, 3]);
  check('six ranked — the unsettled and the neutral are not in the running', e.ranked, 6);
  check('best first, net of BTC, sign-adjusted for the bear', e.best.map(x => [x.symbol, x.net]), [['SOL', 7], ['ETH', 4], ['BTC', 2]]);
  check('a call with no baseline says it is ranked on the raw move', [e.best[2].netOf, e.best[0].netOf], ['move', 'btc']);
  check('worst first among the worst, and the bear\'s wrongness reads negative', e.worst.map(x => [x.symbol, x.net]), [['XRP', -7], ['ADA', -5], ['DOGE', 0.1]]);
  check('no call is in both lists', e.best.some(b => e.worst.some(w => w.symbol === b.symbol)), false);
  check('a smaller limit', scoreExtremes(rows, 1).best.map(x => x.symbol), ['SOL']);
  check('with too few for both lists, the worst is empty rather than repeating the best',
        scoreExtremes(rows.slice(0, 2), 3).worst, []);
  check('no records, no crash', scoreExtremes(null), { best: [], worst: [], ranked: 0 });

  // through the brief: whole record, not the recent window, and both ends in the words
  const b = scoreBrief(rows, { now: NOW });
  check('the brief carries both lists', [b.bestCalls[0].symbol, b.worstCalls[0].symbol, b.rankedCalls], ['SOL', 'XRP', 6]);
  ok('the best is named, net of BTC', /Your best call, net of the market, across every coin: SOL bull at 60 on 2026-09-0\d \(x\) — \+8% at 24h, \+7% net of BTC\./.test(b.text));
  ok('and the worst right after it', /Your worst: XRP bull/.test(b.text));
  ok('one without the other is never said', !/Your best call/.test(scoreBrief(rows.slice(0, 1), { now: NOW }).text));
}


/*  The analyst writes generatedAt itself and guesses the time — on one
    machine two thirds of the reports were hours off, mostly ahead. The
    file's write time is the true time of the call.                        */
suite('scoreStampTime — the file\'s write time wins when the stamp is hours off');
{
  const wrote = Date.parse('2026-09-21T17:08:05Z');
  const rep = at => ({ symbol: 'FIL', generatedAt: at, stoch: { call: 'bull' } });
  check('within ten minutes, the stamp stands', scoreStampTime(rep('2026-09-21T17:10:00Z'), wrote).changed, false);
  const ahead = scoreStampTime(rep('2026-09-21T22:01:00Z'), wrote);
  check('five hours ahead is re-timed to the write', [ahead.changed, ahead.report.generatedAt], [true, '2026-09-21T17:08:05.000Z']);
  check('and the model\'s stamp is kept for the audit', ahead.report.generatedAtModel, '2026-09-21T22:01:00Z');
  check('and it is marked, so it is never done twice', scoreStampTime(ahead.report, wrote + 3 * HOUR).changed, false);
  check('behind by an hour is re-timed the same way', scoreStampTime(rep('2026-09-21T16:00:00Z'), wrote).report.generatedAt, '2026-09-21T17:08:05.000Z');
  check('a day or more apart is a copied file, not a bad stamp — left alone', scoreStampTime(rep('2026-09-18T17:00:00Z'), wrote).changed, false);
  check('no stamp at all takes the write time', scoreStampTime({ symbol: 'X' }, wrote).report.generatedAt, '2026-09-21T17:08:05.000Z');
  check('an unusable write time changes nothing', scoreStampTime(rep('2026-09-21T22:01:00Z'), NaN).changed, false);
  check('the slack and the ceiling are what the file says', [SCORE_STAMP_SLACK_MS, SCORE_STAMP_MAX_MS], [10 * 60e3, 24 * HOUR]);
  check('the original object is not mutated', rep('2026-09-21T22:01:00Z').generatedAtStamped, undefined);
}

later(async () => {
  suite('settleAll — a report stamped hours ahead is re-timed, and its record settles again from the right time');
  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odysseus-stamp-'));
  const NOW = Date.parse('2026-09-21T20:00:00Z');
  const wroteAt = NOW - 30 * HOUR;                                   // written 30h ago …
  const file = path.join(dir, 'FIL-2026-09-20-1900.json');
  fs.writeFileSync(file, JSON.stringify({ symbol: 'FIL', generatedAt: new Date(wroteAt + 5 * HOUR).toISOString(),   // … stamped 25h ago
    stoch: { call: 'bull', conviction: 60, horizon: 'next 24h' }, news: { call: 'bear', conviction: 50, horizon: 'next 24h' },
    crowd: { call: 'bear', conviction: 55, horizon: 'next 24h', keyNumbers: { crowdTag: 'crowded longs', crowdedSide: 'long' } } }));
  fs.utimesSync(file, new Date(wroteAt), new Date(wroteAt));
  // a record already settled from the wrong stamp, at the 24h mark that the wrong stamp made due
  writeTrack('stoch', [{ id: 'FIL-2026-09-20-1900', symbol: 'FIL', generatedAt: new Date(wroteAt + 5 * HOUR).toISOString(), call: 'bull', conviction: 60,
    setup: '4H bull', mark: 24, horizon: 'next 24h', checks: { '24': { pct: 9, grade: 'right', entry: 1, exit: 1.09 } }, postmortem: { text: 'kept', at: 'x' } }], dir);
  // hourly bars: flat at 1.00 until the true call, then a steady climb — so the right 24h reads +2.4%, the wrong stamp read +9%
  const bars = []; for (let h = 0; h < 40; h++) { const t = wroteAt - 4 * HOUR + h * HOUR; const c = t < wroteAt ? 1 : 1 + 0.001 * ((t - wroteAt) / HOUR); bars.push({ t, o: c, h: c, l: c, c, v: 1 }); }
  const engine = { ready: async () => {}, g: { TFS: [{ key: '1H', bybit: '60', ms: HOUR }], symbolOf: c => ({ sym: c, bybit: c + 'USDT' }), pull: async () => bars } };
  const res = await settleAll(engine, { dir, now: NOW });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('the report on disk now carries the write time', onDisk.generatedAt, new Date(wroteAt).toISOString());
  check('with the model\'s stamp kept beside it', [onDisk.generatedAtModel != null, onDisk.generatedAtStamped], [true, true]);
  check('the pass says what it did — one report, one existing record (the news record is new, born with the right time)', [res.restamped, res.retimed], [1, 1]);
  const st = readTrack('stoch', dir)[0];
  check('the record was re-timed to match', st.generatedAt, new Date(wroteAt).toISOString());
  ok('its wrongly settled 24h mark was cleared and settled again, from the true time', st.checks['24'] && Math.abs(st.checks['24'].pct - 2.4) < 0.15);
  check('the analyst\'s own words on the record survived', st.postmortem.text, 'kept');
  const cr = readTrack('crowd', dir);
  check('the crowd side got its own record file, born with the right time', [cr.length, cr[0].generatedAt, cr[0].setup], [1, new Date(wroteAt).toISOString(), 'crowded longs → bear']);
  ok('and it settled at 24h from the same bars — a bear call into a +2.4% climb is wrong', cr[0].checks['24'] && cr[0].checks['24'].grade === 'wrong');
  check('the pass counts all three records', [res.stochCount, res.newsCount, res.crowdCount], [1, 1, 1]);
  const res2 = await settleAll(engine, { dir, now: NOW });
  check('the next pass has nothing to re-time', [res2.restamped, res2.retimed], [0, 0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

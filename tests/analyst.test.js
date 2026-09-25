/* analyst.test.js — the Analyst view's validator and inbox logic.

   The view renders something written OUTSIDE the app by a model. That is exactly
   the input you cannot trust to be well-formed, so the validation is the part
   worth testing: a malformed report must be refused with a reason a person can
   act on, and a report whose summary contradicts its own two analysts must be
   flagged rather than quietly passed along.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['analyst.js']);
const {analystParse, analystParseMany, analystNormalise, analystMerge,
       analystShortlist,
       analystAgreementOf, analystDirectionOf, analystStale, analystAgeLabel,
       analystLatestFor, ANALYST_SCHEMA, ANALYST_MAX,
       analystHistoryFilter, analystHistoryStory, analystPctLabel, analystPriceLabel,
       analystGradeLabel, analystDueLabel, analystTallyLabel, analystHistoryCall,
       analystHistoryTally, analystHistoryLean, analystLeanLabel, analystHistoryStrip, ANALYST_LEAN_MIN,
       analystHistoryMagnitude, analystHistoryConviction, analystConvBand, ANALYST_CONV_BANDS,
       analystHistoryCalibration, analystHistorySpeed,
       analystHistoryCombo, analystHistoryCombos, analystHistoryComboTally, analystHistoryComboSides} = app;

const AT = Date.parse('2026-09-16T08:00:00.000Z');

function report(over){
  return Object.assign({
    schema: ANALYST_SCHEMA,
    symbol: 'sol',
    generatedAt: '2026-09-16T08:00:00.000Z',
    stoch: {analyst:'stochastic', call:'bull', conviction:64, horizon:'4H, next 20 hours',
            for:['89% of 19 past 4H bull crosses from overbought'], against:['thin sample at 19'],
            keyNumbers:{biasScore:17}},
    news:  {analyst:'news', call:'bull', conviction:55, horizon:'next 24h',
            for:['coin-specific move on a cited listing'], against:[],
            catalyst:{found:true, what:'exchange listing', source:'https://example.invalid/a', beforeTheMove:true},
            keyNumbers:{movePct:28, classification:'spec'}},
    reconciliation: {agreement:'agree', direction:'bull', confidence:70,
                     headline:'Both sides say up, for different reasons.',
                     body:['The indicator likes the 4H cross.','The move has a cited cause.'],
                     clashes:[], whatWouldChangeIt:'A funding flip.'},
  }, over||{});
}

suite('analyst — what it refuses, and why');
check('nothing at all', analystParse('').error, 'nothing to read');
ok('not JSON', /not valid JSON/.test(analystParse('{nope').error));
ok('a bare array is not a report', !analystNormalise([1,2]).ok);
ok('the wrong schema is named in the error',
   /expected "odysseus.analyst.v1"/.test(analystNormalise(report({schema:'something.else'})).error));
check('a missing schema says so',
      analystNormalise(report({schema:undefined})).error,
      'wrong schema — expected "odysseus.analyst.v1", got "nothing"');
check('no symbol', analystNormalise(report({symbol:'  '})).error, 'the report names no symbol');
check('no reconciliation', analystNormalise(report({reconciliation:undefined})).error,
      'the report has no reconciliation block');
check('no headline', analystNormalise(report({reconciliation:{agreement:'agree'}})).error,
      'the reconciliation has no headline');
check('an unreadable date', analystNormalise(report({generatedAt:'last tuesday'})).error,
      'generatedAt is not a date I can read');

suite('analyst — a good report');
{
  const r = analystNormalise(report()).report;
  check('the symbol is upper-cased', r.symbol, 'SOL');
  check('the timestamp is parsed', r.at, AT);
  check('the headline survives', r.headline, 'Both sides say up, for different reasons.');
  check('both calls survive', [r.stoch.call, r.news.call], ['bull','bull']);
  check('conviction survives', r.stoch.conviction, 64);
  check('the catalyst survives', r.news.catalyst.what, 'exchange listing');
  check('body paragraphs survive', r.body.length, 2);
  ok('and nothing is disputed', r.agreementDisputed === false);
}

suite('analyst — agreement is computed, not taken on trust');
check('two bulls agree', analystAgreementOf('bull','bull'), 'agree');
check('two bears agree', analystAgreementOf('bear','bear'), 'agree');
check('two neutrals agree', analystAgreementOf('neutral','neutral'), 'agree');
check('bull against bear is a clash', analystAgreementOf('bull','bear'), 'clash');
check('bear against bull is a clash', analystAgreementOf('bear','bull'), 'clash');
check('one neutral is partial', analystAgreementOf('bull','neutral'), 'partial');
check('a missing call is partial', analystAgreementOf('bull',null), 'partial');
check('a nonsense call is partial', analystAgreementOf('bull','sideways'), 'partial');

check('a clash has no single direction', analystDirectionOf('bull','bear'), 'split');
check('agreement keeps the direction', analystDirectionOf('bear','bear'), 'bear');
check('the side with a call leads', analystDirectionOf('neutral','bear'), 'bear');

suite('analyst — three analysts: the crowd side joins the arithmetic');
check('three the same agree', analystAgreementOf('bull','bull','bull'), 'agree');
check('three neutrals agree', analystAgreementOf('neutral','neutral','neutral'), 'agree');
check('two aligned and one neutral is partial', analystAgreementOf('bull','bull','neutral'), 'partial');
check('one call and two neutrals is partial', analystAgreementOf('neutral','neutral','bear'), 'partial');
check('any two opposed is a clash, whatever the third says', analystAgreementOf('bull','neutral','bear'), 'clash');
check('two bulls against a bear is still a clash — three is not a vote', analystAgreementOf('bull','bull','bear'), 'clash');
check('a missing crowd call among two others is partial', analystAgreementOf('bull','bull',null), 'partial');
check('an absent crowd side (old report) leaves the two-way answer alone', analystAgreementOf('bull','bull',undefined), 'agree');
check('a three-way clash is split', analystDirectionOf('bull','bull','bear'), 'split');
check('the crowd alone with a call leads', analystDirectionOf('neutral','neutral','bear'), 'bear');
check('all neutral is neutral', analystDirectionOf('neutral','neutral','neutral'), 'neutral');
{
  const crowd = {analyst:'crowd', call:'bear', conviction:58, horizon:'next 24 hours',
                 for:['funding 0.06%/8h, 71% of accounts long and rising into a 3% fall'], against:['OI only +2%'],
                 keyNumbers:{crowdTag:'crowded longs', crowdScore:18, crowdedSide:'long', stance:'fade'}};
  const r = analystNormalise(report({crowd})).report;
  check('the crowd block is carried as a third side', [r.crowd.call, r.crowd.conviction], ['bear', 58]);
  check('and it turns the claimed agreement into a disputed one', [r.agreement, r.derivedAgreement, r.agreementDisputed], ['agree', 'clash', true]);
  const old = analystNormalise(report()).report;
  check('a report without a crowd block has no crowd side, not a neutral one', old.crowd, null);
  check('and still derives the two-way agreement', [old.derivedAgreement, old.agreementDisputed], ['agree', false]);
  const three = analystNormalise(report({crowd: Object.assign({}, crowd, {call:'bull'}), reconciliation:{headline:'h'}})).report;
  check('three bulls with no claimed agreement derive agree and bull', [three.agreement, three.direction], ['agree', 'bull']);
}

/*  The reconciler is a model, and a model can write "agree" over a bull and a
    bear. The view must not launder that — it shows both and says which to
    trust. This is the single most important assertion in the file.          */
suite('analyst — a summary that contradicts its own evidence is flagged');
{
  const bad = analystNormalise(report({
    news: Object.assign(report().news, {call:'bear'}),
    reconciliation: Object.assign(report().reconciliation, {agreement:'agree'}),
  })).report;
  ok('the dispute is flagged', bad.agreementDisputed === true);
  check('the claim is kept as written', bad.agreement, 'agree');
  check('and the truth is kept beside it', bad.derivedAgreement, 'clash');
}
{
  const fine = analystNormalise(report({
    news: Object.assign(report().news, {call:'bear'}),
    reconciliation: Object.assign(report().reconciliation, {agreement:'clash', direction:'split'}),
  })).report;
  ok('an honest clash is not flagged', fine.agreementDisputed === false);
  check('and keeps its split direction', fine.direction, 'split');
}
{
  const silent = analystNormalise(report({
    reconciliation: Object.assign(report().reconciliation, {agreement:'sideways'}),
  })).report;
  check('an unusable agreement falls back to the computed one', silent.agreement, 'agree');
  ok('which is not a dispute, because nothing was claimed', silent.agreementDisputed === false);
}

suite('analyst — the inbox');
{
  const a = analystNormalise(report()).report;
  const b = analystNormalise(report({symbol:'BTC', generatedAt:'2026-09-16T09:00:00.000Z'})).report;
  const older = analystNormalise(report({generatedAt:'2026-09-15T08:00:00.000Z'})).report;

  check('newest first', analystMerge([a], [b]).map(r=>r.symbol), ['BTC','SOL']);
  check('and across timestamps too', analystMerge([older], [a]).map(r=>r.at), [AT, older.at]);
  check('the same report twice is one report', analystMerge([a], [a]).length, 1);
  check('same coin, different time, is two', analystMerge([a], [older]).length, 2);
  check('an empty add changes nothing', analystMerge([a], []).length, 1);

  const many = [];
  for (let i = 0; i < ANALYST_MAX + 12; i++)
    many.push(analystNormalise(report({generatedAt: new Date(AT - i*3600e3).toISOString()})).report);
  check('the inbox is capped', analystMerge([], many).length, ANALYST_MAX);
  check('and keeps the newest', analystMerge([], many)[0].at, AT);

  check('the latest for a coin is findable', analystLatestFor([b,a], 'sol').symbol, 'SOL');
  check('lower case works too', analystLatestFor([b,a], 'btc').symbol, 'BTC');
  check('a coin with nothing returns nothing', analystLatestFor([b,a], 'doge'), null);
}

suite('analyst — a read decays');
{
  const r = analystNormalise(report()).report;
  ok('fresh is not stale', analystStale(r, AT + 3600e3) === false);
  ok('six hours is the line', analystStale(r, AT + 6*3600e3) === false);
  ok('past it, it is stale', analystStale(r, AT + 7*3600e3) === true);
  check('minutes read as minutes', analystAgeLabel(r, AT + 30*60e3), '30m ago');
  check('hours as hours', analystAgeLabel(r, AT + 5*3600e3), '5h ago');
  check('days as days', analystAgeLabel(r, AT + 50*3600e3), '2d ago');
}

suite('analyst — a file can hold several');
{
  const many = JSON.stringify([report(), report({symbol:'BTC'})]);
  const out = analystParseMany(many);
  ok('both are read', out.ok && out.reports.length === 2);
  ok('with no error', out.error === null);

  const mixed = JSON.stringify([report(), {schema:'nope'}]);
  const part = analystParseMany(mixed);
  ok('one good one bad still yields the good one', part.ok && part.reports.length === 1);
  ok('and names which one failed', /#2/.test(part.error));

  const allBad = analystParseMany(JSON.stringify([{schema:'nope'}]));
  ok('all bad is a refusal', allBad.ok === false && allBad.reports.length === 0);
}

suite('analyst — "worth a look" is the newest fresh read per coin, ranked');
{
  const NOW = Date.parse('2026-09-16T12:00:00Z');
  const mk = (symbol, agreement, direction, confidence, hoursAgo, extra) => Object.assign({
    symbol, agreement, direction, confidence, at: NOW - hoursAgo*3600e3, headline: symbol + ' h',
    stoch:{}, news:{}, body:[], clashes:[],
  }, extra || {});
  const reps = [
    mk('SOL', 'agree', 'bull', 80, 1),
    mk('SOL', 'clash', 'split', 90, 3),          // older SOL read — the newer one wins
    mk('ETH', 'partial', 'bear', 80, 2),
    mk('ARB', 'clash', 'split', 95, 1),          // a clash has no direction to trade
    mk('ZEC', 'clash', 'bull', 70, 1),           // a clash that still names a lean
    mk('LTC', 'agree', 'neutral', 90, 1),        // two neutrals is "no trade"
    mk('OLD', 'agree', 'bull', 99, 9),           // stale
    mk('DIS', 'agree', 'bull', 60, 1, {agreementDisputed:true}),
  ];
  const s = analystShortlist(reps, NOW);
  check('one row per coin, newest read only', s.filter(x=>x.symbol==='SOL').length, 1);
  check('and it is the newer SOL read', s.find(x=>x.symbol==='SOL').agreement, 'agree');
  check('agreement at 80 outranks partial at 80', s[0].symbol, 'SOL');
  check('agreement scores the whole confidence', s[0].score, 80);
  check('partial scores three quarters', s.find(x=>x.symbol==='ETH').score, 60);
  check('a clash with a lean scores half', s.find(x=>x.symbol==='ZEC').score, 35);
  ok('a split has nothing to trade and is left out', !s.find(x=>x.symbol==='ARB'));
  ok('a neutral consensus is left out', !s.find(x=>x.symbol==='LTC'));
  ok('a stale read is left out however confident', !s.find(x=>x.symbol==='OLD'));
  ok('a disputed summary is shown but marked', s.find(x=>x.symbol==='DIS').disputed === true);
  check('the order is by score', s.map(x=>x.score).every((v,i,a)=> i===0 || a[i-1] >= v), true);
  check('a limit is honoured', analystShortlist(reps, NOW, 2).length, 2);
  check('nothing in, nothing out', analystShortlist([], NOW), []);
}

/*  The history pane renders rows the relay assembled (mcp/history.js); the
    app only filters, tallies and words them. The wording is the part a
    person reads, so it is the part pinned here.                          */
suite('analyst — the history pane: filters');
{
  const row = (id, symbol, hoursAgo, open, over) => Object.assign({
    id, symbol, at: Date.parse('2026-09-16T12:00:00Z') - hoursAgo*3600e3, open, ageH: hoursAgo,
    price: {entry: 100, checks: {24:{state:'pending'},48:{state:'pending'},72:{state:'pending'},168:{state:'pending'}}},
    live: null, next: {hours: 24, dueAt: Date.parse('2026-09-16T12:00:00Z') + (24-hoursAgo)*3600e3},
    stoch: {call:'bull', conviction:60, grades:{}}, news: {call:'neutral', conviction:20, grades:{}},
    desk: {direction:'bull', agreement:'partial', confidence:50, grades:{}},
  }, over || {});
  const rows = [row('a','SOL',1,true), row('b','SONIC',5,true), row('c','BTC',2,false, {stoch:{call:'neutral',grades:{}}, desk:{direction:'split',grades:{}}}), row('d','SOL',30,false)];
  check('newest first', analystHistoryFilter(rows, {}).map(r=>r.id), ['a','c','b','d']);
  check('a coin prefix', analystHistoryFilter(rows, {symbol:'so'}).map(r=>r.id), ['a','b','d']);
  check('only open', analystHistoryFilter(rows, {only:'open'}).map(r=>r.id), ['a','b']);
  check('only settled', analystHistoryFilter(rows, {only:'settled'}).map(r=>r.id), ['c','d']);
  check('rows where a side actually called a direction', analystHistoryFilter(rows, {side:'stoch'}).map(r=>r.id), ['a','b','d']);
  check('the desk side reads its direction', analystHistoryCall(rows[2], 'desk'), 'split');
  check('nothing in, nothing out', analystHistoryFilter(null, {}), []);
}

/*  The record split by direction. A side that is right 60% overall can be
    a bull specialist and a coin flip on bears, or the reverse; the split is
    the only view that tells those two apart, so it is pinned here.      */
suite('analyst — the record, split by what each side called');
{
  const r = (stochCall, stochGrade, newsCall, newsGrade, open) => ({
    id: 'r' + Math.random(), symbol: 'SOL', at: 0, open: !!open, price: { entry: 1, checks: {} },
    stoch: { call: stochCall, grades: stochGrade ? { 24: stochGrade, live: stochGrade } : {} },
    news:  { call: newsCall,  grades: newsGrade  ? { 24: newsGrade,  live: newsGrade  } : {} },
    desk:  { direction: 'bull', grades: { 24: 'right' } },
  });
  const rows = [
    r('bull', 'right', 'bear', 'wrong'),
    r('bull', 'right', 'bear', 'right'),
    r('bull', 'wrong', 'bull', 'right'),
    r('bear', 'wrong', 'bull', 'right'),
    r('bear', 'flat',  'neutral', null),
    r('neutral', null, 'bear', null, true),     // open, ungraded
  ];
  const all = analystHistoryTally(rows, 'stoch', 24);
  check('all calls: neutral is left out, the rest counted', all.count, 5);
  check('rate is right over decided, flat excluded', [all.right, all.wrong, all.flat, all.rate], [2, 2, 1, 50]);
  const bull = analystHistoryTally(rows, 'stoch', 24, 'bull');
  check('stoch on bulls: 2 of 3 right', [bull.count, bull.right, bull.wrong, bull.rate], [3, 2, 1, 67]);
  const bear = analystHistoryTally(rows, 'stoch', 24, 'bear');
  check('stoch on bears: 0 of 1 decided, 1 flat', [bear.count, bear.right, bear.wrong, bear.flat, bear.rate], [2, 0, 1, 1, 0]);
  const nbear = analystHistoryTally(rows, 'news', 24, 'bear');
  check('news on bears: one right, one wrong, one still waiting', [nbear.count, nbear.right, nbear.wrong, nbear.pending, nbear.rate], [3, 1, 1, 1, 50]);
  check('news on bulls: clean', analystHistoryTally(rows, 'news', 24, 'bull').rate, 100);
  check('the unsplit tally equals the relay\'s own rule (same as no call filter)',
        analystHistoryTally(rows, 'news', 24).count, analystHistoryTally(rows, 'news', 24, 'bull').count + analystHistoryTally(rows, 'news', 24, 'bear').count);
  check('no rows, no crash', analystHistoryTally(null, 'stoch', 24, 'bull').count, 0);

  const lean = analystHistoryLean(rows, 'stoch');
  check('how stoch leans: 3 bull, 2 bear, 1 neutral', [lean.bull, lean.bear, lean.other, lean.bullPct], [3, 2, 1, 60]);
  check('worded — five directional calls is exactly enough to say even-handed', analystLeanLabel(lean), '3 bull · 2 bear · 1 neutral — even-handed');
  check('under the minimum, the lean is withheld', analystLeanLabel({bull: 4, bear: 0, other: 1, bullPct: 100}), '4 bull · 0 bear · 1 neutral');
  check('past the minimum, a strong bull share is said', analystLeanLabel({bull: 8, bear: 2, other: 0, bullPct: 80}), '8 bull · 2 bear — leans bull');
  check('and a bear one', analystLeanLabel({bull: 1, bear: 6, other: 0, bullPct: 14}), '1 bull · 6 bear — leans bear');
  check('and a balance', analystLeanLabel({bull: 5, bear: 5, other: 2, bullPct: 50}), '5 bull · 5 bear · 2 neutral — even-handed');
  check('nothing yet says so', analystLeanLabel(analystHistoryLean([], 'news')), 'no calls yet');
  check('the minimum is what the hint says', ANALYST_LEAN_MIN, 5);
}

suite('analyst — the strip on a collapsed row: each side\'s call and latest verdict');
{
  const row = {
    open: true,
    stoch: { call: 'bull', grades: { 24: 'right', 48: 'wrong', live: 'right' } },
    news:  { call: 'bear', grades: { live: 'wrong' } },
    desk:  { direction: 'split', grades: {} },
  };
  const s = analystHistoryStrip(row, [24, 48, 72, 168]);
  check('stoch: the last settled mark wins over the live read', s[0], { side: 'stoch', call: 'bull', grade: 'wrong', mark: '48h' });
  check('news: nothing settled yet, so the live read', s[1], { side: 'news', call: 'bear', grade: 'wrong', mark: 'so far' });
  check('crowd: a row from before the crowd analyst has an empty crowd slot', s[2], { side: 'crowd', call: null, grade: null, mark: null });
  check('desk: split is a call but never a verdict', s[3], { side: 'desk', call: 'split', grade: null, mark: null });
  const settled = analystHistoryStrip({ open: false, stoch: { call: 'bull', grades: { live: 'right' } }, news: {}, desk: {} }, [24]);
  check('a settled row never shows a live verdict', settled[0].grade, null);
  check('no call at all', settled[1], { side: 'news', call: null, grade: null, mark: null });
}

/*  Win rate says how often; magnitude says how much. Direction-adjusted so
    a bear's fall and a bull's rise both read as "points toward the call". */
suite('analyst — magnitude: how much a right call won, how much a wrong one lost');
{
  const row = (call, grade, pct) => ({
    price: { checks: { 24: { state: 'settled', pct } } }, live: null,
    stoch: { call, grades: grade ? { 24: grade } : {} },
  });
  const rows = [
    row('bull', 'right', 5), row('bull', 'wrong', -2),
    row('bear', 'right', -4), row('bear', 'wrong', 3),
    row('neutral', null, 1), row('bull', 'flat', 0.1),
  ];
  const m = analystHistoryMagnitude(rows, 'stoch', 24);
  check('two right, two wrong counted; neutral and flat left out', [m.nRight, m.nWrong], [2, 2]);
  check('right average is direction-adjusted and positive', m.avgRight, 4.5);
  check('wrong average is direction-adjusted and negative', m.avgWrong, -2.5);

  const bullOnly = analystHistoryMagnitude(rows, 'stoch', 24, 'bull');
  check('a call filter narrows it', [bullOnly.nRight, bullOnly.nWrong, bullOnly.avgRight, bullOnly.avgWrong], [1, 1, 5, -2]);

  const live = analystHistoryMagnitude([{ stoch: { call: 'bull', grades: { live: 'right' } }, live: { pct: 2.4 }, price: { checks: {} } }], 'stoch', 'live');
  check('the live mark reads row.live.pct', live.avgRight, 2.4);

  check('nothing decided yet is null, not zero', analystHistoryMagnitude([row('bull', null, 1)], 'stoch', 24),
        { nRight: 0, nWrong: 0, avgRight: null, avgWrong: null });
  check('no rows, no crash', analystHistoryMagnitude(null, 'stoch', 24), { nRight: 0, nWrong: 0, avgRight: null, avgWrong: null });
}

suite('analyst — conviction, by field name per side');
check('the two analysts carry conviction', analystHistoryConviction({ stoch: { conviction: 55 } }, 'stoch'), 55);
check('the desk carries confidence', analystHistoryConviction({ desk: { confidence: 70 } }, 'desk'), 70);
check('nothing there is null, not a crash', analystHistoryConviction({ stoch: null }, 'stoch'), null);

suite('analyst — confidence bands: coarse on purpose');
check('under 40', analystConvBand(12), '<40');
check('the 40-59 band is inclusive both ends', [analystConvBand(40), analystConvBand(59)], ['40–59', '40–59']);
check('60-79', analystConvBand(65), '60–79');
check('80 and up, including exactly 100', [analystConvBand(80), analystConvBand(100)], ['80+', '80+']);
check('nothing given is no band', [analystConvBand(null), analystConvBand(undefined)], [null, null]);

suite('analyst — calibration: does the confidence number actually mean anything');
{
  const row = (conv, grade, mark) => ({ open: false, stoch: { call: 'bull', conviction: conv, grades: { [mark]: grade } } });
  const rows = [
    row(85, 'right', 24), row(90, 'right', 24), row(75, 'wrong', 24),
    row(30, 'wrong', 24), row(35, 'right', 24), row(50, 'wrong', 24), row(55, 'wrong', 24),
  ];
  const c = analystHistoryCalibration(rows, 'stoch', [24, 48, 72, 168]);
  check('four bands, each with its own rate', c.map(x => [x.band, x.count, x.right, x.wrong, x.rate]),
        [['<40', 2, 1, 1, 50], ['40–59', 2, 0, 2, 0], ['60–79', 1, 0, 1, 0], ['80+', 2, 2, 0, 100]]);

  const openRow = { open: true, stoch: { call: 'bear', conviction: 82, grades: { live: 'wrong' } } };
  check('an open call is read off its live verdict, the same as the strip', analystHistoryCalibration([openRow], 'stoch', [24]),
        [{ band: '80+', count: 1, right: 0, wrong: 1, rate: 0 }]);

  check('nothing decided yet is an empty list, not a wall of hollow 0%s',
        analystHistoryCalibration([{ stoch: { call: 'bull', conviction: 70, grades: {} } }], 'stoch', [24]), []);
  check('no rows, no crash', analystHistoryCalibration(null, 'stoch', [24]), []);
}

suite('analyst — speed: how soon a call shows its hand, not when it finally settles');
{
  const row = (call, grades) => ({ stoch: { call, grades } });
  const rows = [
    row('bull', { 24: 'flat', 48: 'right' }),     // first decisive at 48h, right
    row('bull', { 24: 'right' }),                 // first decisive at 24h, right
    row('bear', { 24: 'wrong', 48: 'right' }),    // decisive at 24h already — the later flip doesn't count
    row('bull', {}),                              // never decisive
    row('neutral', { 24: 'right' }),               // no directional call — excluded regardless of grade
  ];
  const s = analystHistorySpeed(rows, 'stoch', [24, 48, 72, 168]);
  check('two right (48h and 24h, averaging 36h), one wrong (24h)', [s.nRight, s.avgRight, s.nWrong, s.avgWrong], [2, 36, 1, 24]);
  check('no rows, no crash', analystHistorySpeed(null, 'stoch', [24, 48]), { nRight: 0, nWrong: 0, avgRight: null, avgWrong: null });
}

/*  What the three said together, and how that went — graded on the desk,
    because the desk's call is the one there is to trade.                */
suite('analyst — combinations: when all three line up, is it actually better');
{
  const row = (s, n, d, dGrade) => ({
    stoch: { call: s, grades: {} }, news: { call: n, grades: {} },
    desk: { direction: d, grades: dGrade ? { 24: dGrade } : {} },
  });
  const c = analystHistoryCombo(row('bull', 'bull', 'bull'));
  check('the key and label carry all three', [c.key, c.label], ['bull|bull|bull', 'S bull · N bull · D bull']);
  check('all three bull is unanimous', c.unanimous, true);
  check('all three bear is unanimous too', analystHistoryCombo(row('bear', 'bear', 'bear')).unanimous, true);
  check('two of three is not', analystHistoryCombo(row('bull', 'bull', 'bear')).unanimous, false);
  check('three neutrals is not unanimous — there is no direction to agree on', analystHistoryCombo(row('neutral', 'neutral', 'neutral')).unanimous, false);
  check('a missing side reads as none', analystHistoryCombo({ stoch: { call: 'bull' }, news: {}, desk: {} }).key, 'bull|none|none');

  const rows = [
    row('bull', 'bull', 'bull', 'right'), row('bull', 'bull', 'bull', 'right'), row('bull', 'bull', 'bull', 'wrong'),
    row('bull', 'bear', 'bull', 'wrong'), row('bull', 'bear', 'bull', 'wrong'),
    row('bear', 'bear', 'bear', 'right'),
    row('bull', 'bear', 'split', null),
  ];
  const combos = analystHistoryCombos(rows);
  check('every combination that occurred, most common first', combos.map(c => [c.label, c.n]),
        [['S bull · N bull · D bull', 3], ['S bull · N bear · D bull', 2], ['S bear · N bear · D bear', 1], ['S bull · N bear · D split', 1]]);

  const unan = analystHistoryComboTally(rows, 'unanimous', 24);
  check('all three agree: 4 calls, 3 right', [unan.count, unan.right, unan.wrong, unan.rate], [4, 3, 1, 75]);
  const rest = analystHistoryComboTally(rows, 'rest', 24);
  check('not all three (with a directional desk): 2 calls, both wrong', [rest.count, rest.right, rest.wrong, rest.rate], [2, 0, 2, 0]);
  check('the split-desk row is in neither — nothing to grade', unan.count + rest.count, 6);
  const one = analystHistoryComboTally(rows, 'bull|bear|bull', 24);
  check('one specific combination', [one.count, one.rate], [2, 0]);
  check('a split desk combination tallies to nothing, not to zero-percent', analystHistoryComboTally(rows, 'bull|bear|split', 24).count, 0);
  check('no rows, no crash', analystHistoryCombos(null), []);
}

/*  In a clash, "how did the desk do" is not "who was right". Grading each
    side over the combination's rows is what answers that — and the two
    lines are mirror images, because a grade is only the call against the
    same price path.                                                     */
suite('analyst — combinations, side by side: in a clash, who had the direction right');
{
  check('all three bull is one line, naming all three', analystHistoryComboSides({ stoch: 'bull', news: 'bull', desk: 'bull' }),
        [{ call: 'bull', side: 'stoch', label: 'S+N+D bull' }]);
  check('a clash the desk sided with stoch on is two lines', analystHistoryComboSides({ stoch: 'bull', news: 'bear', desk: 'bull' }),
        [{ call: 'bull', side: 'stoch', label: 'S+D bull' }, { call: 'bear', side: 'news', label: 'N bear' }]);
  check('a neutral side has no line', analystHistoryComboSides({ stoch: 'neutral', news: 'bear', desk: 'bear' }),
        [{ call: 'bear', side: 'news', label: 'N+D bear' }]);
  check('a split desk drops out, the two analysts stay', analystHistoryComboSides({ stoch: 'bull', news: 'bear', desk: 'split' }),
        [{ call: 'bull', side: 'stoch', label: 'S bull' }, { call: 'bear', side: 'news', label: 'N bear' }]);
  check('nothing directional is no lines', analystHistoryComboSides({ stoch: 'neutral', news: 'neutral', desk: 'neutral' }), []);

  // the mirror: stoch bull / news bear, price went up twice and down once
  const row = (sg, ng) => ({
    stoch: { call: 'bull', grades: { 24: sg } }, news: { call: 'bear', grades: { 24: ng } },
    desk: { direction: 'bull', grades: { 24: sg } },
  });
  const rows = [row('right', 'wrong'), row('right', 'wrong'), row('wrong', 'right')];
  const sBull = analystHistoryComboTally(rows, 'bull|bear|bull', 24, 'stoch');
  const nBear = analystHistoryComboTally(rows, 'bull|bear|bull', 24, 'news');
  check('the bull line: stoch (and the desk with it) 2 of 3', [sBull.right, sBull.wrong, sBull.rate], [2, 1, 67]);
  check('the bear line is its mirror: news 1 of 3', [nBear.right, nBear.wrong, nBear.rate], [1, 2, 33]);
  check('and the desk line equals whichever side it followed', analystHistoryComboTally(rows, 'bull|bear|bull', 24).rate, sBull.rate);
}

suite('analyst — the history pane: numbers as a person reads them');
{
  check('a rise has a plus', analystPctLabel(2.345), '+2.3%');
  check('a fall has a real minus sign', analystPctLabel(-0.4), '−0.4%');
  check('zero has neither', analystPctLabel(0), '0.0%');
  check('nothing is a dash', analystPctLabel(null), '—');
  check('two decimals when asked', analystPctLabel(1.234, 2), '+1.23%');
  check('a big price keeps no decimals', analystPriceLabel(64231.7), '$64232');
  check('a thousand is not stripped to one', analystPriceLabel(1000), '$1000');
  check('a mid price keeps three', analystPriceLabel(1.5), '$1.5');
  check('a small coin keeps its digits', analystPriceLabel(0.00001234), '$0.0000123');
  check('trailing zeros go', analystPriceLabel(0.5), '$0.5');
  check('no price is a dash', analystPriceLabel(null), '—');
  check('right', analystGradeLabel('right'), '✓ right');
  check('wrong', analystGradeLabel('wrong'), '✗ wrong');
  check('flat', analystGradeLabel('flat'), '~ flat');
  check('pending is an ellipsis', analystGradeLabel('pending'), '…');
  check('no call is said plainly', analystGradeLabel(null), 'no call');
  const NOW = Date.parse('2026-09-16T12:00:00Z');
  check('a mark hours away', analystDueLabel({dueAt: NOW + 19*3600e3}, NOW), 'in 19h');
  check('minutes away', analystDueLabel({dueAt: NOW + 20*60e3}, NOW), 'in 20m');
  check('just passed', analystDueLabel({dueAt: NOW - 10*60e3}, NOW), 'due now');
  check('well past, waiting on a pass', analystDueLabel({dueAt: NOW - 3*3600e3}, NOW), 'due, settles on the next pass');
  check('no mark is nothing', analystDueLabel(null, NOW), '');
  check('a tally', analystTallyLabel({count:5, right:3, wrong:1, flat:1, pending:0, rate:75}), '3✓ 1✗ 1~ (75%)');
  check('with some waiting', analystTallyLabel({count:3, right:1, wrong:0, flat:0, pending:2, rate:100}), '1✓ (100%) · 2 waiting');
  check('nothing graded yet says so', analystTallyLabel({count:2, right:0, wrong:0, flat:0, pending:2, rate:null}), '0 graded · 2 waiting');
  check('no calls at all is a dash', analystTallyLabel({count:0}), '—');
}

suite('analyst — the history pane: the story of one call, in words');
{
  const NOW = Date.parse('2026-09-16T12:00:00Z');
  const row = {
    id:'SOL-1', symbol:'SOL', at: NOW - 30*3600e3, open: true, ageH: 30,
    next: {hours: 48, dueAt: NOW + 18*3600e3, due: false},
    price: {entry: 100, checks: {
      24: {state:'settled', pct: 2.4, exit: 102.4, maxUp: 5.1, maxDown: -0.8},
      48: {state:'pending'}, 72: {state:'pending'}, 168: {state:'pending'}}},
    live: {entry: 100, price: 103.6, pct: 3.6, maxUp: 5.1, maxDown: -0.8, hoursIn: 30},
    stoch: {call:'bear', conviction: 45, horizon:'4H, next 20 hours', grades: {24:'wrong', live:'wrong'}},
    news:  {call:'neutral', conviction: 22, horizon:'next 24h', grades: {24:null, live:null}},
    desk:  {direction:'bull', agreement:'partial', confidence: 34, grades: {24:'right', live:'right'}},
  };
  const lines = analystHistoryStory(row, [24,48,72,168], NOW);
  check('what stoch said', lines[0], 'Stoch said bear at 45, for 4H, next 20 hours.');
  check('what news said', lines[1], 'News said neutral at 22, for next 24h.');
  check('what the desk did', lines[2], 'The desk leaned bull at 34 (partial).');
  check('the entry', lines[3], 'Price at the call: $100.');
  check('the settled mark, with the run each way and every verdict', lines[4],
        'At 24h: $102.4 (+2.4%) — ran +5.1% / −0.8% on the way → stoch wrong, desk right.');
  check('where it stands now', lines[5], 'Now, 30h in: $103.6 (+3.6%), peaked +5.1%, dipped −0.8% → stoch wrong so far, desk right so far.');
  check('and what comes next', lines[6], 'Next check: 48h, in 18h.');
  const closed = Object.assign({}, row, {open:false, next:null, live:null});
  ok('a settled call ends with that', analystHistoryStory(closed, [24,48,72,168], NOW).pop() === 'Every checkpoint is settled.');
  const split = Object.assign({}, row, {desk:{direction:'split', agreement:'clash', confidence:50, grades:{}}});
  check('a split desk is worded as one', analystHistoryStory(split, [24], NOW)[2], 'The desk called it split at 50 (clash).');
  const nocall = Object.assign({}, row, {stoch:{call:null, grades:{}}});
  check('a missing call is said plainly', analystHistoryStory(nocall, [24], NOW)[0], 'Stoch made no call.');
  ok('the relay\'s marks win over the built-in list', !analystHistoryStory(row, [24], NOW).some(l => /At 48h/.test(l)));
}

suite('analyst — the record note: what each call-maker said its own record changed');
{
  const raw = report({
    stoch: Object.assign({}, report().stoch, { recordNote: 'my 4H bull calls are 2 of 7; conviction cut from 64 to 45' }),
    news: Object.assign({}, report().news, { recordNote: '  ' }),
    reconciliation: Object.assign({}, report().reconciliation, { recordNote: 'in clashes I have done better following news (4 of 5)' }),
  });
  const r = analystNormalise(raw).report;
  check('the stoch note survives the validator', r.stoch.recordNote, 'my 4H bull calls are 2 of 7; conviction cut from 64 to 45');
  check('a blank one is null, not an empty string', r.news.recordNote, null);
  check('and the desk has one of its own', r.recordNote, 'in clashes I have done better following news (4 of 5)');
  check('a report written before the field existed is simply without one', analystNormalise(report()).report.recordNote, null);
}

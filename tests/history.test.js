/* history.test.js — every call, laid against what price did after.

   mcp/history.js is the one place both analysts' records sit side by side,
   and it is for the person only. What is worth pinning: the price path is
   lifted out once and is the same whichever record carried it; each side is
   graded from its OWN call against that shared path, and a neutral or split
   call is never a hit or a miss; the desk's verdict is graded the same way
   even though score.js never tracks it; and the tallies keep undecided calls
   out of the rate rather than counting them as misses.
   part of Odysseus */

const path = require('path');
const MCP = path.join(__dirname, '..', 'mcp');
const {
  historyPricePath, historySideGrades, historyRow, historyMerge, historyTally, historySummary,
  historyDeskBrief, historyDeskFollowed, historyDeskBriefMarkdown, historyWriteDeskBrief, DESK_BRIEF_FILE,
  HISTORY_SIDES, SCORE_CHECKS,
} = require(path.join(MCP, 'history.js'));

const GEN = '2026-09-10T00:00:00.000Z';
const GEN_MS = Date.parse(GEN);
const NOW = GEN_MS + 30 * 3600e3;

function report(over) {
  return Object.assign({
    schema: 'odysseus.analyst.v1', symbol: 'sol', generatedAt: GEN,
    stoch: { call: 'bull', conviction: 60, horizon: '4H, next 20 hours', keyNumbers: { bestSetup: '4H bull cross, oversold — strong', hitRate: '71% of 42' } },
    news: { call: 'neutral', conviction: 30, horizon: 'next 24h', catalyst: { found: true, what: 'a listing', beforeTheMove: true }, keyNumbers: { movePct: 12.5, classification: 'spec' } },
    reconciliation: { agreement: 'partial', direction: 'bull', confidence: 55, headline: 'Lean bull.' },
  }, over || {});
}
const settled = (pct, extra) => Object.assign({ pct, grade: pct > 0.5 ? 'right' : pct < -0.5 ? 'wrong' : 'flat', entry: 100, exit: 100 + pct, maxUp: Math.max(pct, 1), maxDown: Math.min(pct, -0.4) }, extra || {});
const rec = (id, call, checks) => ({ id, symbol: 'SOL', generatedAt: GEN, call, conviction: 50, checks: checks || {} });

suite('history — the price path is one thing, whichever record carried it');
{
  const p = historyPricePath(rec('a', 'bull', { 24: settled(3) }), rec('a', 'neutral', {}));
  check('the entry comes from the settled record', p.entry, 100);
  check('24h is settled', p.checks['24'].state, 'settled');
  check('with the move', p.checks['24'].pct, 3);
  check('and the excursion', [p.checks['24'].maxUp, p.checks['24'].maxDown], [3, -0.4]);
  check('48h is pending', p.checks['48'].state, 'pending');
  check('every mark is present', Object.keys(p.checks).sort(), SCORE_CHECKS.map(String).sort());
  const q = historyPricePath(null, rec('a', 'bear', { 24: { state: 'expired' } }));
  check('an expired mark stays expired', q.checks['24'].state, 'expired');
  check('with no entry to show', q.entry, null);
  check('no records at all is all pending', historyPricePath(null, null).checks['168'].state, 'pending');
}

suite('history — each side is graded from its own call against that path');
{
  const price = historyPricePath(rec('a', 'bull', { 24: settled(3), 48: settled(-2) }), null);
  const live = { pct: 1.2 };
  check('a bull is right at 24h and wrong at 48h', [historySideGrades('bull', price, live)['24'], historySideGrades('bull', price, live)['48']], ['right', 'wrong']);
  check('a bear is the mirror', [historySideGrades('bear', price, live)['24'], historySideGrades('bear', price, live)['48']], ['wrong', 'right']);
  check('and right so far', historySideGrades('bull', price, live).live, 'right');
  check('a neutral call is null at every mark, not pending', historySideGrades('neutral', price, live)['24'], null);
  check('and null live', historySideGrades('neutral', price, live).live, null);
  check('a split is graded like a neutral', historySideGrades('split', price, live)['24'], null);
  check('an unsettled mark is pending for a real call', historySideGrades('bull', price, live)['72'], 'pending');
  check('no live mark means no live grade', historySideGrades('bull', price, null).live, null);
}

suite('history — one row carries all three verdicts and the words behind them');
{
  const row = historyRow('SOL-1', report(), rec('SOL-1', 'bull', { 24: settled(3) }), rec('SOL-1', 'neutral', { 24: settled(3) }), NOW,
                         { entry: 100, price: 104, pct: 4, maxUp: 5, maxDown: -1, hoursIn: 30, at: NOW, grade: 'right' });
  check('symbol upper-cased', row.symbol, 'SOL');
  check('age in hours', row.ageH, 30);
  ok('still open — three marks to go', row.open === true);
  check('the next mark is 48h', row.next.hours, 48);
  check('stoch graded right at 24h', row.stoch.grades['24'], 'right');
  check('news made no directional call, so nothing to grade', row.news.grades['24'], null);
  check('the desk leaned bull and is graded too', row.desk.grades['24'], 'right');
  check('the desk carries its own numbers', [row.desk.agreement, row.desk.confidence, row.desk.headline], ['partial', 55, 'Lean bull.']);
  check('the stoch setup comes through', row.stoch.bestSetup, '4H bull cross, oversold — strong');
  check('the news catalyst comes through', [row.news.catalyst, row.news.catalystBefore, row.news.movePct], ['a listing', true, 12.5]);
  check('the live mark is on the row, ungraded', [row.live.pct, row.live.grade], [4, undefined]);
  check('and graded per side', [row.stoch.grades.live, row.news.grades.live, row.desk.grades.live], ['right', null, 'right']);
  ok('both sides are marked as tracked', row.stoch.tracked && row.news.tracked);
  check('a report from before the crowd analyst has an empty crowd side, never a neutral one', [row.crowd.call, row.crowd.tracked, row.crowd.grades['24']], [null, false, null]);
  check('its combination key is unchanged, so old rows keep their buckets', typeof row.crowd, 'object');
}

suite('history — the crowd analyst is a third graded side');
{
  const rep = report({ crowd: { call: 'bear', conviction: 58, horizon: 'next 24 hours',
                                keyNumbers: { crowdTag: 'crowded longs', crowdedSide: 'long', stance: 'fade' } } });
  const row = historyRow('SOL-9', rep, rec('SOL-9', 'bull', { 24: settled(3) }), null, NOW, null, rec('SOL-9', 'bear', { 24: settled(3) }));
  check('the crowd call and what it was reading come through', [row.crowd.call, row.crowd.crowdTag, row.crowd.crowdedSide], ['bear', 'crowded longs', 'long']);
  check('graded against the same price path as the others', [row.stoch.grades['24'], row.crowd.grades['24']], ['right', 'wrong']);
  ok('and marked as tracked', row.crowd.tracked === true);
  const only = historyRow('SOL-10', rep, null, null, NOW, null, rec('SOL-10', 'bear', { 24: settled(-2) }));
  check('the price path can come from the crowd record alone', [only.price.checks['24'].pct, only.crowd.grades['24'], only.stoch.grades['24']], [-2, 'right', 'wrong']);
  const merged = historyMerge([{ id: 'SOL-9', report: rep }], [rec('SOL-9', 'bull', { 24: settled(3) })], [], NOW, null, 10, [rec('SOL-9', 'bear', { 24: settled(3) })]);
  check('merge takes the crowd track as its last argument', merged[0].crowd.grades['24'], 'wrong');
  const sum = historySummary(merged);
  check('the summary has a crowd side', [sum.crowd['24'].count, sum.crowd['24'].wrong], [1, 1]);
  const bare = historyRow('SOL-2', report(), null, null, NOW, null);
  ok('a report with no records yet is still a row', !!bare && bare.open === true);
  check('everything pending', bare.stoch.grades['24'], 'pending');
  ok('and says the record has not caught up', bare.stoch.tracked === false);
  check('the entry can come from the live mark when nothing is settled',
        historyRow('SOL-3', report(), null, null, NOW, { entry: 99, price: 100, pct: 1 }).price.entry, 99);
  check('a report with no date is nothing', historyRow('x', { symbol: 'SOL' }, null, null, NOW, null), null);
  const done = historyRow('SOL-4', report(), rec('SOL-4', 'bull', { 24: settled(1), 48: settled(1), 72: settled(1), 168: { state: 'expired' } }), null, NOW, null);
  ok('four marks in, it is closed', done.open === false && done.next === null);
  check('and the expired mark shows as such', done.stoch.grades['168'], 'expired');
}

suite('history — the merge is newest first and forgets records without a report');
{
  const reports = [
    { id: 'SOL-old', report: report({ generatedAt: '2026-09-09T00:00:00.000Z' }) },
    { id: 'SOL-1', report: report() },
    { id: 'BTC-1', report: report({ symbol: 'BTC', generatedAt: '2026-09-10T06:00:00.000Z' }) },
    { id: 'broken', report: { symbol: 'X' } },
  ];
  const stoch = [rec('SOL-1', 'bull', { 24: settled(2) }), rec('gone', 'bull', { 24: settled(9) })];
  const rows = historyMerge(reports, stoch, [], NOW, { SOL: { 'SOL-1': { entry: 100, price: 103, pct: 3 } } });
  check('newest first', rows.map(r => r.id), ['BTC-1', 'SOL-1', 'SOL-old']);
  ok('a record with no report is not a row', !rows.some(r => r.id === 'gone'));
  ok('a broken report is not a row', !rows.some(r => r.id === 'broken'));
  check('live marks are matched by symbol and id', rows.find(r => r.id === 'SOL-1').live.pct, 3);
  check('and not smeared onto another call for the same coin', rows.find(r => r.id === 'SOL-old').live, null);
  check('a limit is honoured', historyMerge(reports, stoch, [], NOW, null, 2).length, 2);
}

suite('history — tallies keep the undecided out of the rate');
{
  const mk = (id, call, g24, gLive) => ({
    id, symbol: 'X', at: 1, open: true,
    stoch: { call, grades: { 24: g24, live: gLive } },
    news: { call: 'neutral', grades: { 24: null, live: null } },
    desk: { direction: call === 'neutral' ? 'split' : call, grades: { 24: g24, live: gLive } },
  });
  const rows = [mk('a', 'bull', 'right', 'right'), mk('b', 'bull', 'wrong', 'right'), mk('c', 'bear', 'right', 'flat'),
                mk('d', 'bull', 'flat', 'wrong'), mk('e', 'neutral', null, null), mk('f', 'bear', 'pending', 'right')];
  const t = historyTally(rows, 'stoch', 24);
  check('directional calls are counted', t.count, 5);
  check('two right, one wrong, one flat, one waiting', [t.right, t.wrong, t.flat, t.pending], [2, 1, 1, 1]);
  check('the rate is over decided calls only', t.rate, 67);
  check('the neutral is counted apart', t.noCall, 1);
  check('the news side, all neutral, has no rate', historyTally(rows, 'news', 24).rate, null);
  check('and a full count of no-calls', historyTally(rows, 'news', 24).noCall, 6);
  check('the desk is tallied from its direction', historyTally(rows, 'desk', 24).count, 5);
  check('the live mark is tallied too', historyTally(rows, 'stoch', 'live').right, 3);
  const s = historySummary(rows);
  check('a summary has all three sides', Object.keys(s).sort(), HISTORY_SIDES.slice().sort());
  check('with every mark and live', Object.keys(s.stoch).sort(), SCORE_CHECKS.map(String).concat(['live']).sort());
  check('nothing in gives empty tallies, not an error', historySummary([]).desk['24'].count, 0);
}

suite('historyDeskBrief — the desk\'s own record, for the desk');
{
  // rows straight from historyRow, so the brief reads exactly what the person's view reads
  let i = 0;
  const row = (dir, agreement, stochCall, newsCall, pct, confidence, over) => {
    const id = 'd' + (++i);
    const gen = new Date(GEN_MS - i * 3600e3).toISOString();
    const rep = report(Object.assign({ symbol: 'C' + i, generatedAt: gen,
      stoch: { call: stochCall, conviction: 50, horizon: '4H, next 20 hours' },
      news: { call: newsCall, conviction: 50, horizon: 'next 24h' },
      reconciliation: { agreement, direction: dir, confidence, headline: 'h' + i } }, over || {}));
    const checks = pct == null ? {} : { 24: settled(pct) };
    return historyRow(id, rep, Object.assign(rec(id, stochCall, checks), { symbol: 'C' + i, generatedAt: gen, mark: 24 }),
                      Object.assign(rec(id, newsCall, checks), { symbol: 'C' + i, generatedAt: gen, mark: 24 }), NOW, null);
  };
  check('nothing at all', historyDeskBrief([], NOW).text, 'The desk has no track record yet.');
  ok('open calls only', /made 1 call\(s\); none has reached/.test(historyDeskBrief([row('bull', 'agree', 'bull', 'bull', null, 60)], NOW).text));

  const rows = [
    row('bull', 'clash', 'bull', 'bear', 3, 60), row('bull', 'clash', 'bull', 'bear', 2, 55), row('bull', 'clash', 'bull', 'bear', 1, 50),
    row('bull', 'clash', 'bull', 'bear', 4, 65), row('bull', 'clash', 'bull', 'bear', -2, 70),          // followed stoch: 4 of 5
    row('bear', 'clash', 'bull', 'bear', -3, 60), row('bear', 'clash', 'bull', 'bear', 2, 60), row('bear', 'clash', 'bull', 'bear', 1, 60),
    row('bear', 'clash', 'bull', 'bear', 2, 60), row('bear', 'clash', 'bull', 'bear', 3, 60),           // followed news: 1 of 5
    row('bull', 'agree', 'bull', 'bull', 2, 80), row('bull', 'agree', 'bull', 'bull', 3, 85),
    row('split', 'clash', 'bull', 'bear', 2, 50),                                                        // never graded
  ];
  const b = historyDeskBrief(rows, NOW);
  check('graded calls exclude the split', [b.calls, b.graded], [13, 12]);
  check('the desk read at its own mark', [b.overall.own.right, b.overall.own.wrong], [7, 5]);
  check('split by agreement', [b.byAgreement.clash.right, b.byAgreement.clash.wrong], [5, 5]);
  check('in clashes, by which side it followed', [b.inClashes['followed stoch'].rate, b.inClashes['followed news'].rate], [80, 20]);
  ok('and the lean is said out loud', /done better following stoch \(80% against 20% following news\)/.test(b.text));
  check('the misses carry which side was followed, newest first, capped', b.recentMisses.map(m => m.followed), ['followed stoch', 'followed news', 'followed news', 'followed news']);
  ok('a miss reads with the headline', /Miss: C6 bull at 70 .* \(clash, followed stoch\) — -2% at 24h\. You wrote: "h6"/.test(b.text));
  ok('nothing in it grades either analyst on its own', !/stoch analyst|news analyst|stoch record|news record/i.test(b.text));

  check('followed: both agreed', historyDeskFollowed(rows[10]), 'both agreed');
  check('followed: a split follows no one', historyDeskFollowed(rows[12]), null);

  const many = [];
  for (let k = 0; k < 4; k++) many.push(row('split', 'clash', 'bull', 'bear', 2, 50));
  many.push(row('bull', 'agree', 'bull', 'bull', 2, 80), row('bull', 'agree', 'bull', 'bull', 2, 80));
  const h = historyDeskBrief(many, NOW);
  ok('calling split most of the time is said out loud', h.hedging.warn && /called split or neutral on 4 of your last 6/.test(h.text));

  const md = historyDeskBriefMarkdown(b);
  ok('the markdown is for the reconciler and says so', /never quote it to either analyst/.test(md));
  ok('and carries the lines', /- Your last 12 directional reconciliation/.test(md));

  const fs = require('fs'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odysseus-desk-'));
  const out = historyWriteDeskBrief(dir, NOW);
  check('the file lands where /read looks', path.basename(out.file), DESK_BRIEF_FILE);
  ok('and an empty verdicts dir writes an honest empty brief', /no track record yet/.test(fs.readFileSync(out.file, 'utf8')));
  fs.rmSync(dir, { recursive: true, force: true });
}

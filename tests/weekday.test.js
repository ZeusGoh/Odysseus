/* weekday.test.js — the day-of-week backtest: the return is close-to-close, the live bar is
   left out, days are UTC days, the buckets sum back to the whole, and a day only "leans"
   once its average is clear of the all-days average by more than the noise allows.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['weekday.js']);
const {weekdayReturns, weekdayStat, weekdayT, weekdayLean, weekdayStats, weekdayToday, weekdayLabel,
       WEEKDAY_NAMES, WEEKDAY_THIN, WEEKDAY_LEAN_T} = app;

const DAY = 86400000;
const MON = Date.UTC(2026, 0, 5);            // Monday 5 Jan 2026, 00:00 UTC
const bar = (t, o, c, h, l) => ({t, o, c, h: h == null ? Math.max(o, c) : h, l: l == null ? Math.min(o, c) : l, v: 1});

// a run of daily bars from `start`, each closing where the previous one did times (1 + pct/100)
function run(start, pcts, p0) {
  const out = [];
  let prev = p0 || 100;
  out.push(bar(start - DAY, prev, prev));
  pcts.forEach((pct, i) => {
    const c = prev * (1 + pct / 100);
    out.push(bar(start + i * DAY, prev, c));
    prev = c;
  });
  return out;
}

suite('weekdayReturns — close-to-close, UTC weekday, live bar dropped');
{
  // Mon +1, Tue -2, Wed +3, Thu (live, ignored)
  const rows = weekdayReturns(run(MON, [1, -2, 3, 99]));
  check('three closed days measured', rows.length, 3);
  check('weekdays are UTC', rows.map(r => WEEKDAY_NAMES[r.d]), ['Mon', 'Tue', 'Wed']);
  near('Monday is the move from Sunday\'s close', rows[0].pct, 1, 1e-9);
  near('Tuesday is measured from Monday\'s close, not the seed', rows[1].pct, -2, 1e-9);
  check('the last bar is live and not counted', rows.some(r => Math.abs(r.pct - 99) < 1), false);
  check('too short a series gives nothing', weekdayReturns([bar(MON, 1, 1), bar(MON + DAY, 1, 1)]), []);
  check('a bar with no usable open is skipped, not a NaN row',
        weekdayReturns([bar(MON, 100, 100), {t: MON + DAY, o: 0, c: 100, h: 100, l: 100}, bar(MON + 2 * DAY, 100, 101), bar(MON + 3 * DAY, 101, 101)]).length, 1);
}

suite('weekdayStat — the numbers of one bucket');
{
  const rows = [{pct: 2, range: 4, dip: -1}, {pct: -4, range: 6, dip: -5}, {pct: 1, range: 2, dip: 0}, {pct: -6, range: 8, dip: -7}];
  const s = weekdayStat(rows);
  check('count', s.n, 4);
  near('average', s.avg, -1.75, 1e-9);
  near('median', s.med, -1.5, 1e-9);
  check('win rate is the share of up days', s.win, 50);
  near('cumulative is the plain sum', s.cum, -7, 1e-9);
  check('falls of 3% or more are counted', s.big, 2);
  check('and falls of 5% or more separately', s.huge, 1);
  ok('the standard error is set once there are two rows', s.se > 0);
  check('a small bucket is thin', s.thin, true);
  check('an empty bucket has nulls, not zeros', weekdayStat([]).avg, null);
  check('one row has no standard error', weekdayStat([{pct: 1, range: 1, dip: 0}]).se, null);
}

suite('weekdayT / weekdayLean — a lean needs to clear the noise');
{
  const st = {avg: 0.5, se: 0.2};
  check('t is the distance in standard errors', weekdayT(st, 0.1), 2);
  check('two standard errors up leans up', weekdayLean(2), 'up');
  check('two down leans down', weekdayLean(-2), 'down');
  check('inside the band is flat', weekdayLean(WEEKDAY_LEAN_T - 0.01), 'flat');
  check('no t at all is flat', weekdayLean(null), 'flat');
  check('no standard error gives no t', weekdayT({avg: 1, se: null}, 0), null);
}

suite('weekdayStats — the buckets add up to the whole, and the worst day is the worst average');
{
  // eight weeks: every Thursday about -3%, every Wednesday about +2%, everything else
  // noise around flat — a little jitter on each so every bucket has a spread to measure
  const pcts = [];
  for (let w = 0; w < 8; w++) for (let d = 0; d < 7; d++) {
    const wd = (1 + d) % 7;                       // MON is a Monday
    const j = w % 2 ? 1 : -1;
    pcts.push(wd === 4 ? -3 + 0.1 * j : wd === 3 ? 2 + 0.1 * j : 1 * j);
  }
  pcts.push(0);                                   // the live bar
  const s = weekdayStats(run(MON, pcts), {recentDays: 21});
  check('every closed day landed in a bucket', s.byDay.reduce((n, b) => n + b.n, 0), s.n);
  check('and there are 56 of them', s.n, 56);
  check('Thursday is the worst day', WEEKDAY_NAMES[s.worstDay], 'Thu');
  check('Wednesday is the best', WEEKDAY_NAMES[s.bestDay], 'Wed');
  near('Thursday averages its move', s.byDay[4].avg, -3, 1e-9);
  check('Thursday has eight days behind it', s.byDay[4].n, 8);
  check('every Thursday was down', s.byDay[4].win, 0);
  check('Thursday leans down', s.byDay[4].lean, 'down');
  check('Wednesday leans up', s.byDay[3].lean, 'up');
  check('a flat day is flat', s.byDay[1].lean, 'flat');
  check('the rank runs worst to best', s.rank[0], 4);
  check('and ends on the best', s.rank[s.rank.length - 1], 3);
  check('the worst single days are Thursdays', s.worst.slice(0, 3).map(w => WEEKDAY_NAMES[w.d]), ['Thu', 'Thu', 'Thu']);
  check('newest of equal size first', s.worst[0].t > s.worst[1].t, true);
  check('the recent window is the last N closed days', s.recent.reduce((n, b) => n + b.n, 0), 21);
  check('the year table has one row', Object.keys(s.byYear), ['2026']);
  near('with Thursday\'s average in it', s.byYear['2026'][4], -3, 1e-9);
  check('the overall average is carried', typeof s.all.avg, 'number');
  check('an empty series gives null', weekdayStats([]), null);
}

suite('weekdayToday — the line the view leads with');
{
  const s = weekdayStats(run(MON, Array(28).fill(1).concat([0])));
  const thu = weekdayToday(s, Date.UTC(2026, 0, 8, 15));   // a Thursday, mid-afternoon UTC
  check('names the UTC weekday', thu.name, 'Thursday');
  check('and hands back its bucket', thu.all.n, 4);
  check('late on a UTC Wednesday is still Wednesday', weekdayToday(s, Date.UTC(2026, 0, 7, 23, 59)).d, 3);
  check('nothing without stats', weekdayToday(null, 0), null);
  ok('the label reads as a sentence', /avg .* median .* up .* days/.test(weekdayLabel(thu.all)));
  check('an empty bucket says so', weekdayLabel({n: 0}), 'no days yet');
}

suite('constants');
check('the thin floor matches History and Sessions', WEEKDAY_THIN, 30);
check('seven names, Sunday first', WEEKDAY_NAMES[0], 'Sun');

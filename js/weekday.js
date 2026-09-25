/* weekday.js — the day-of-week backtest: which day a coin bleeds on, and
   which day it pays. Pure — daily candles in, per-weekday statistics out.

   The unit is the daily bar's close-to-close return, so "Thursday" is the
   move from Wednesday's close to Thursday's close. Bybit's daily bars open
   at 00:00 UTC, so the days here are UTC days — in Kuala Lumpur or
   Singapore a "Thursday" runs from 08:00 Thursday to 08:00 Friday. The
   last bar of the series is the live one and is left out: its close has
   not happened yet.

   Every rate here is a lean, not a law. The standard error is carried
   alongside the average so the view can say how far a day sits from the
   crowd in units the sample size sets, rather than reading +0.3% as a
   fact when the day-to-day noise is ten times that.
   part of Odysseus */

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_THIN  = 30;      // fewer days than this behind a rate and it is dimmed, like everywhere else
const WEEKDAY_RECENT_DAYS = 365;
const WEEKDAY_LEAN_T = 1.0;    // standard errors from the all-days average before a day "leans"
const WEEKDAY_BIG = -3, WEEKDAY_HUGE = -5;   // the two bad-day thresholds, in percent

/*  One row per closed daily bar that has a previous close to measure from.
    `d` is the UTC weekday, `y` the UTC year; `pct` is close-to-close, `oc`
    open-to-close, `range` the bar's span and `dip` how far it fell below
    its open — all as a percentage of the reference price.               */
function weekdayReturns(candles) {
  const out = [];
  if (!candles || candles.length < 3) return out;
  for (let i = 1; i < candles.length - 1; i++) {        // the last bar is live
    const b = candles[i], p = candles[i - 1];
    if (!b || !p || !(p.c > 0) || !(b.o > 0)) continue;
    const dt = new Date(b.t);
    out.push({
      t: b.t, d: dt.getUTCDay(), y: dt.getUTCFullYear(),
      pct: (b.c - p.c) / p.c * 100,
      oc: (b.c - b.o) / b.o * 100,
      range: (b.h - b.l) / b.o * 100,
      dip: (b.l - b.o) / b.o * 100,
    });
  }
  return out;
}

function weekdayMedian(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/*  The statistics of one bucket of return rows. `sd` is the sample standard
    deviation and `se` the standard error of the average; both null on a
    bucket too small to have them.                                        */
function weekdayStat(rows) {
  const n = rows.length;
  const s = { n, avg: null, med: null, win: null, cum: null, sd: null, se: null,
              range: null, dip: null, big: 0, huge: 0, thin: n < WEEKDAY_THIN };
  if (!n) return s;
  const pcts = rows.map(r => r.pct);
  const sum = pcts.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  s.avg = +avg.toFixed(3);
  s.med = +weekdayMedian(pcts).toFixed(3);
  s.win = Math.round(pcts.filter(x => x > 0).length / n * 100);
  s.cum = +sum.toFixed(1);
  s.range = +(rows.reduce((a, r) => a + r.range, 0) / n).toFixed(2);
  s.dip = +(rows.reduce((a, r) => a + r.dip, 0) / n).toFixed(2);
  s.big = pcts.filter(x => x <= WEEKDAY_BIG).length;
  s.huge = pcts.filter(x => x <= WEEKDAY_HUGE).length;
  if (n > 1) {
    const sd = Math.sqrt(pcts.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1));
    s.sd = +sd.toFixed(3);
    s.se = +(sd / Math.sqrt(n)).toFixed(3);
  }
  return s;
}

/*  How far a day's average sits from the all-days average, in standard
    errors, and the lean that earns: up, down, or flat. Null when the
    bucket is too small to have a standard error at all.                 */
function weekdayT(stat, overallAvg) {
  if (!stat || stat.se == null || !(stat.se > 0) || overallAvg == null) return null;
  return +((stat.avg - overallAvg) / stat.se).toFixed(2);
}

function weekdayLean(t) {
  if (t == null) return 'flat';
  return t >= WEEKDAY_LEAN_T ? 'up' : t <= -WEEKDAY_LEAN_T ? 'down' : 'flat';
}

/*  The whole table. `byDay` and `recent` are seven entries, Sunday first,
    each a weekdayStat with `t` and `lean` attached; `byYear` is the average
    per weekday per UTC year; `worst` the biggest single-day falls, newest
    of equal size first; `rank` the seven day indexes from worst average to
    best.                                                                 */
function weekdayStats(candles, opts) {
  const o = opts || {};
  const rows = weekdayReturns(candles);
  if (!rows.length) return null;
  const all = weekdayStat(rows);
  const recentN = o.recentDays == null ? WEEKDAY_RECENT_DAYS : o.recentDays;
  const recentRows = rows.slice(-recentN);
  const recentAll = weekdayStat(recentRows);

  const bucket = (rs, base) => {
    const st = weekdayStat(rs);
    st.t = weekdayT(st, base);
    st.lean = weekdayLean(st.t);
    return st;
  };
  const byDay = [], recent = [];
  for (let d = 0; d < 7; d++) {
    byDay.push(bucket(rows.filter(r => r.d === d), all.avg));
    recent.push(bucket(recentRows.filter(r => r.d === d), recentAll.avg));
  }

  const byYear = {};
  for (const r of rows) {
    if (!byYear[r.y]) byYear[r.y] = Array.from({ length: 7 }, () => []);
    byYear[r.y][r.d].push(r.pct);
  }
  for (const y of Object.keys(byYear))
    byYear[y] = byYear[y].map(a => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : null);

  const worst = rows.slice().sort((a, b) => a.pct - b.pct || b.t - a.t).slice(0, o.worst == null ? 10 : o.worst)
    .map(r => ({ t: r.t, d: r.d, pct: +r.pct.toFixed(2) }));

  const rank = [0, 1, 2, 3, 4, 5, 6].filter(d => byDay[d].n)
    .sort((a, b) => byDay[a].avg - byDay[b].avg || a - b);

  return { from: rows[0].t, to: rows[rows.length - 1].t, n: rows.length,
           all, byDay, recentAll, recent, byYear, worst, rank,
           worstDay: rank.length ? rank[0] : null, bestDay: rank.length ? rank[rank.length - 1] : null };
}

/*  Today's entry in the table — the UTC weekday `now` falls in, with the
    all-history and last-year buckets for it. This is the line the view
    leads with: "it is a Thursday, and Thursdays have done this".       */
function weekdayToday(stats, now) {
  if (!stats) return null;
  const d = new Date(now == null ? Date.now() : now).getUTCDay();
  return { d, name: WEEKDAY_LONG[d], all: stats.byDay[d], recent: stats.recent[d] };
}

// a one-line reading of a day's bucket, for a title or a note
function weekdayLabel(st) {
  if (!st || !st.n) return 'no days yet';
  const sign = v => (v > 0 ? '+' : '') + v;
  return sign(st.avg.toFixed(2)) + '% avg · ' + sign(st.med.toFixed(2)) + '% median · ' +
         st.win + '% up · ' + st.n + ' days' + (st.thin ? ' (thin)' : '');
}

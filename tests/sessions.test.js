/* sessions.test.js — session bucketing, the first-touch break rule, the sweep/continuation
   split, and the two things this module is easiest to get quietly wrong: scoring a break by
   close instead of by first touch, and conditioning the sweep rate on "swept first".
   part of Odysseus */
const {load} = require('./harness');
const app = load(['sessions.js']);
const {sessionOfHour, groupSessions, firstBreak, completeDayTriples, sessionStats, sessionLive,
       SESS_DEFS, SESS_THIN} = app;

const DAY = 86400000, HOUR = 3600000;
// one flat hourly bar, easy to override per test
const bar = (t, o, h, l, c) => ({t, o, h:h==null?Math.max(o,c):h, l:l==null?Math.min(o,c):l, c, v:1});

// a full 24-bar day at flat price `p`, with optional overrides keyed by hour
function flatDay(dayIdx, p, overrides){
  const ov = overrides || {};
  const out = [];
  for(let h=0; h<24; h++){
    const t = dayIdx*DAY + h*HOUR;
    const o = ov[h] || {};
    out.push(bar(t, o.o!=null?o.o:p, o.h!=null?o.h:undefined, o.l!=null?o.l:undefined, o.c!=null?o.c:p));
  }
  return out;
}

suite('sessionOfHour — UTC-fixed boundaries');
check('hour 0 is Asia', sessionOfHour(0), 'asia');
check('hour 7 is still Asia', sessionOfHour(7), 'asia');
check('hour 8 turns London', sessionOfHour(8), 'london');
check('hour 12 is still London', sessionOfHour(12), 'london');
check('hour 13 turns New York', sessionOfHour(13), 'ny');
check('hour 23 is still New York', sessionOfHour(23), 'ny');

suite('groupSessions — bucket sizes on a clean day');
{
  const blocks = groupSessions(flatDay(0, 100));
  check('three blocks for one full day', blocks.map(b=>b.key), ['asia','london','ny']);
  check('Asia gets 8 bars', blocks[0].n, SESS_DEFS.asia.bars);
  check('London gets 5 bars', blocks[1].n, SESS_DEFS.london.bars);
  check('New York gets 11 bars', blocks[2].n, SESS_DEFS.ny.bars);
}

suite('firstBreak — the bar that touches first, not where the session closed');
{
  const hi = 110, lo = 90;
  check('no bar reaches either side', firstBreak([bar(0,100,105,95,100)], hi, lo), 'none');
  check('an early wick up decides it, even if later bars fall back',
        firstBreak([bar(0,100,115,100,102), bar(1,102,103,80,82)], hi, lo), 'up');
  check('an early wick down decides it, even if later bars rally back',
        firstBreak([bar(0,100,100,85,95), bar(1,95,130,95,120)], hi, lo), 'down');
  check('one bar taking both sides is ambiguous, not guessed at',
        firstBreak([bar(0,100,120,80,100)], hi, lo), 'ambiguous');
}

suite('completeDayTriples — a gap in the feed excludes the whole day, not just the gap');
{
  const day0 = flatDay(0, 100);
  const day1 = flatDay(1, 100).slice(1);           // missing Asia's first bar
  const day2 = flatDay(2, 100);
  const flat = completeDayTriples(groupSessions([...day0, ...day1, ...day2]));
  check('only the two clean days contribute, three entries each', flat.length, 6);
  check('the incomplete day is skipped entirely', flat.map(f=>f.day), [0,0,0,2,2,2]);
}

suite('sessionStats — the funnel, end to end');
/*  Day 0: a quiet base day (asia/london/ny all 95–105) — this is what day 1's Asia gets
    measured against, since "previous three sessions" for day 1 is exactly day 0's three.
    Day 1: Asia holds inside day 0's range, London expands up through the first bar, New
    York sweeps London's low before continuing above London's high.
    Day 2: Asia does NOT hold (breaks day 1's combined range), London expands down, and New
    York neither sweeps nor continues — the "nothing happened" case.                        */
{
  const day0 = flatDay(0, 100, {
    0:{h:105,l:95}, 8:{h:104,l:96}, 13:{h:103,l:97}
  });
  const day1 = flatDay(1, 100, {
    0:{h:102,l:98},                                  // Asia: 98–102, inside day 0's 95–105 → held
    8:{o:100,h:110,l:100,c:108},                      // London bar 1: breaks up first
    12:{h:112,l:99},                                  // London session low ends at 99 (opposite extreme)
    13:{h:106,l:97},                                  // NY: dips to 97 first — sweeps London's 99 low
    14:{h:120,l:98,c:118}                             // then continues above London's 112 high
  });
  const day2 = flatDay(2, 100, {
    0:{h:125,l:105},                                  // Asia: high 125 breaks day 1's combined range (…120) → not held
    8:{o:110,h:112,l:100,c:102},                       // London bar 1: breaks down first (low < 105)
    12:{h:115,l:98},                                   // London session low 98 (continuation target)
    13:{h:110,l:99}                                    // NY stays inside 98–115: no sweep, no continuation
  });
  const s = sessionStats([...day0, ...day1, ...day2]);

  // day 0 has no prior three sessions of its own, so it can't score a "held" reading —
  // but its Asia/London pair is still complete, so it contributes a plain 'none' London
  // row (nothing broke out of a quiet day). Three days in, only two carry a held verdict.
  check('three scoreable days, day 0 included as a quiet no-break day', s.total, 3);

  check('Asia: one of the two days with a lookback held', s.asia, {n:2, heldRate:50, thin:true});

  check('London: day 0 is a no-break day, then one up and one down',
        s.london,
        {n:3, expansionRate:67, upRate:33, downRate:33, noneRate:33, ambiguousRate:0, thin:true});

  check('New York: swept and continued split independently, not conditioned on each other',
        s.ny.n, 2);
  check('continuation rate is 1 of 2', s.ny.continuationRate, 50);
  check('sweep rate is 1 of 2 — the day that failed to continue also failed to sweep',
        s.ny.sweptRate, 50);
  check('every swept day in this fixture also continued', s.ny.continuationGivenSwept, 100);
  check('every non-swept day in this fixture also failed to continue',
        s.ny.continuationGivenNoSwept, 0);
  near('median continuation move matches the one continuing day, rounded to 2dp',
       s.ny.medContinuation, +((120-112)/112*100).toFixed(2), 1e-6);
  ok('both stages are flagged thin under the 30-sample floor', s.ny.n < SESS_THIN);
}

suite('sessionLive — reads off the data, not the clock');
{
  // a partial "today": Asia complete, London two bars in, no New York yet
  const base = flatDay(0, 100, {0:{h:104,l:96}, 8:{h:103,l:97}, 13:{h:102,l:98}});
  const today = flatDay(1, 100, {0:{h:101,l:99}}).slice(0, 10);   // Asia (8) + 2 London bars
  const live = sessionLive([...base, ...today]);

  check('current session is read from the last loaded bar', live.current, 'london');
  check('Asia is reported complete', live.asia.complete, true);
  check('Asia held inside the prior day\'s range', live.asia.held, true);
  check('London is reported still building', live.london.complete, false);
  check('New York has not started, so there is nothing to report yet', live.ny, null);
}

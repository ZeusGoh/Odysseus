/* sessions.js — Session logic. Splits the 1H tape into Asia / London / New York, then reads
   the sequence: did Asia hold inside the previous three sessions, which way did London break
   out of Asia's range, and did New York continue — including whether it swept London's
   opposite extreme first. Pure functions over candle arrays; sym-keyed wrappers pull from
   the shared `data` table at the bottom.
   part of Odysseus */

/*  Session boundaries are UTC-fixed, not exchange-local: Asia 00:00–08:00, London 08:00–13:00,
    New York 13:00–24:00. Every 1H candle's open hour falls into exactly one bucket, so bucketing
    is a lookup on getUTCHours() — no timezone maths, no daylight-saving edge cases.            */
const SESS_DEFS = {
  asia:   {label:'Asia',       h0:0,  h1:8,  bars:8},
  london: {label:'London',     h0:8,  h1:13, bars:5},
  ny:     {label:'New York',   h0:13, h1:24, bars:11}
};
const SESS_ORDER = ['asia','london','ny'];
const SESS_THIN = 30;           // same sample-size floor as History

function sessionOfHour(h){
  return h < SESS_DEFS.asia.h1 ? 'asia' : h < SESS_DEFS.london.h1 ? 'london' : 'ny';
}

// Chronological run of session blocks — one entry per (day, session) pair actually
// present in the candles. A gap in the feed just yields a short block, which the
// completeness check below then excludes rather than silently mis-scoring.
function groupSessions(candles){
  const blocks = [];
  let cur = null;
  candles.forEach(c=>{
    const day = Math.floor(c.t / 86400000);
    const key = sessionOfHour(new Date(c.t).getUTCHours());
    if(!cur || cur.day !== day || cur.key !== key){
      cur = {day, key, bars:[]};
      blocks.push(cur);
    }
    cur.bars.push(c);
  });
  blocks.forEach(b=>{
    b.high = Math.max(...b.bars.map(x=>x.h));
    b.low  = Math.min(...b.bars.map(x=>x.l));
    b.n = b.bars.length;
    b.t0 = b.bars[0].t;
  });
  return blocks;
}

// The first London bar to trade beyond Asia's range, not where London closed — an
// expansion that later reverses still expanded first, and that's the bar a trader
// would have acted on. A single bar taking both sides can't be assigned a side, so
// it comes back 'ambiguous' rather than guessed at.
function firstBreak(bars, hi, lo){
  for(const bar of bars){
    const up = bar.h > hi, down = bar.l < lo;
    if(up && down) return 'ambiguous';
    if(up) return 'up';
    if(down) return 'down';
  }
  return 'none';
}

function combineRange(entries){
  return {high: Math.max(...entries.map(e=>e.high)), low: Math.min(...entries.map(e=>e.low))};
}

function sessMedian(vals){
  if(!vals.length) return null;
  const s = [...vals].sort((a,b)=>a-b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

// Only days where all three sessions are fully populated qualify — a partial session
// (today's still forming, or a gap in the feed) can't be trusted for a range. Flattened
// in day order so "the previous three sessions" is just the three entries before this one.
function completeDayTriples(blocks){
  const byDay = {};
  blocks.forEach(b=>{ (byDay[b.day] = byDay[b.day] || {})[b.key] = b; });
  const flat = [];
  Object.keys(byDay).map(Number).sort((a,b)=>a-b).forEach(day=>{
    const d = byDay[day];
    if(d.asia && d.london && d.ny &&
       d.asia.n===SESS_DEFS.asia.bars && d.london.n===SESS_DEFS.london.bars && d.ny.n===SESS_DEFS.ny.bars){
      SESS_ORDER.forEach(key=> flat.push({day, type:key, ...d[key]}));
    }
  });
  return flat;
}

/*  The engine, run over one day's three sessions plus the three sessions immediately
    before it. Three separate calls (held / break / continuation) rather than one, because
    each answers a different question and each can be null independently — a day with no
    lookback can still score a break, a day with no break has nothing for New York to do.  */
function analyseSessionDay(prior3, asia, london, ny){
  const out = {held:null, breakDir:null, swept:null, continued:null, continuationMove:null};
  if(prior3.length === 3){
    const lb = combineRange(prior3);
    out.held = asia.low >= lb.low && asia.high <= lb.high;
  }
  out.breakDir = firstBreak(london.bars, asia.high, asia.low);
  if(out.breakDir === 'up' || out.breakDir === 'down'){
    const dir = out.breakDir;
    const contExt = dir==='up' ? london.high : london.low;
    const oppExt  = dir==='up' ? london.low  : london.high;
    out.swept = dir==='up' ? ny.low <= oppExt : ny.high >= oppExt;
    out.continued = dir==='up' ? ny.high > contExt : ny.low < contExt;
    if(out.continued){
      out.continuationMove = dir==='up' ? (ny.high-contExt)/contExt*100 : (contExt-ny.low)/contExt*100;
    }
  }
  return out;
}

/*  Every fully-closed day in the loaded history, replayed and bucketed into three stages.
    The stages are reported separately rather than as one funnel percentage, because the
    denominators differ — not every day expands, so "New York continued" only ever means
    "of the days that expanded", never "of all days".

    Sweep rates are split on whether a sweep happened at all, not on whether it happened
    before the continuation. A sweep-before-continuation can't exist without a continuation,
    so conditioning the headline number on "swept first" would dump every failed day into
    the no-sweep bucket and hand back a rate that looks like evidence and is pure construction.
    continuationGivenSwept / continuationGivenNoSwept are exposed separately instead.        */
function sessionStats(candles){
  if(!candles || candles.length < 24) return null;
  const flat = completeDayTriples(groupSessions(candles));
  const days = [];
  for(let i=0;i+2<flat.length;i+=3){
    const prior3 = flat.slice(Math.max(0,i-3), i);
    days.push({day:flat[i].day, ...analyseSessionDay(prior3, flat[i], flat[i+1], flat[i+2])});
  }
  if(!days.length) return null;

  const withHeld = days.filter(d=>d.held!==null);
  const held = withHeld.filter(d=>d.held).length;

  const upN = days.filter(d=>d.breakDir==='up').length;
  const downN = days.filter(d=>d.breakDir==='down').length;
  const noneN = days.filter(d=>d.breakDir==='none').length;
  const ambigN = days.filter(d=>d.breakDir==='ambiguous').length;
  const expanded = days.filter(d=>d.breakDir==='up'||d.breakDir==='down');

  const swept = expanded.filter(d=>d.swept);
  const noSwept = expanded.filter(d=>!d.swept);
  const continued = expanded.filter(d=>d.continued);
  const contMoves = continued.map(d=>d.continuationMove);

  return {
    total: days.length,
    asia: {n: withHeld.length, heldRate: withHeld.length ? Math.round(held/withHeld.length*100) : null,
           thin: withHeld.length < SESS_THIN},
    london: {n: days.length,
             expansionRate: Math.round((upN+downN)/days.length*100),
             upRate: Math.round(upN/days.length*100), downRate: Math.round(downN/days.length*100),
             noneRate: Math.round(noneN/days.length*100), ambiguousRate: Math.round(ambigN/days.length*100),
             thin: days.length < SESS_THIN},
    ny: {n: expanded.length,
         continuationRate: expanded.length ? Math.round(continued.length/expanded.length*100) : null,
         medContinuation: contMoves.length ? +sessMedian(contMoves).toFixed(2) : null,
         sweptRate: expanded.length ? Math.round(swept.length/expanded.length*100) : null,
         continuationGivenSwept: swept.length ? Math.round(swept.filter(d=>d.continued).length/swept.length*100) : null,
         continuationGivenNoSwept: noSwept.length ? Math.round(noSwept.filter(d=>d.continued).length/noSwept.length*100) : null,
         thin: expanded.length < SESS_THIN},
    days
  };
}

/*  Today's read, using whatever sessions have started so far. Asia is always either absent,
    building or complete by the time London or New York are asked about, since the sessions
    run in wall-clock order — so there is no case where London is live but Asia is not done.
    "Current" is read off the candles themselves (the session the last loaded bar falls in),
    not Date.now() — this stays a pure function of its input and a fixture stays testable.   */
function sessionLive(candles){
  if(!candles || !candles.length) return null;
  const blocks = groupSessions(candles);
  const lastDay = blocks[blocks.length-1].day;
  const today = {};
  blocks.filter(b=>b.day===lastDay).forEach(b=> today[b.key]=b);

  const flat = completeDayTriples(blocks);
  const lookback = flat.length>=3 ? combineRange(flat.slice(-3)) : null;

  const out = {current: blocks[blocks.length-1].key, asia:null, london:null, ny:null};

  if(today.asia){
    const complete = today.asia.n === SESS_DEFS.asia.bars;
    out.asia = {complete, n:today.asia.n, high:today.asia.high, low:today.asia.low,
      held: (complete && lookback) ? (today.asia.low>=lookback.low && today.asia.high<=lookback.high) : null};
  }
  if(today.london && out.asia){
    out.london = {complete: today.london.n===SESS_DEFS.london.bars, n:today.london.n,
      high:today.london.high, low:today.london.low,
      breakDir: firstBreak(today.london.bars, out.asia.high, out.asia.low)};
  }
  if(today.ny && out.london && (out.london.breakDir==='up' || out.london.breakDir==='down')){
    const dir = out.london.breakDir;
    const contExt = dir==='up' ? out.london.high : out.london.low;
    const oppExt  = dir==='up' ? out.london.low  : out.london.high;
    out.ny = {complete: today.ny.n===SESS_DEFS.ny.bars, n:today.ny.n,
      high:today.ny.high, low:today.ny.low,
      swept: dir==='up' ? today.ny.low<=oppExt : today.ny.high>=oppExt,
      continued: dir==='up' ? today.ny.high>contExt : today.ny.low<contExt};
  }
  return out;
}

// ---------- sym-keyed wrappers — the only functions that touch shared app state ----------
function sessionsFor(sym){ return sessionStats(data[sym] && data[sym]['1H']); }
function sessionsLive(sym){ return sessionLive(data[sym] && data[sym]['1H']); }

/* anomalies.js — The anomaly log. Every abnormal move the News detector flags is written down
   with the full snapshot that produced it, then scored at +1h / +4h / +24h against what price
   actually did — so the classifier can be checked instead of trusted.

   This is a research log, not a trade journal. Nothing here has an entry, a stop or a size, and
   nothing here is a simulated trade: "this coin acted strangely" and "I took a trade" are
   different claims and they do not belong in the same table. Trading one of these for real goes
   through journal.js with a real invalidation, the way every other trade does.
   part of Odysseus */

const ANOM_KEY = 'vl.news.anomalies.v1';
const ANOM_CHECKS = [1, 4, 24];        // hours after the flag
const ANOM_THIN = 30;                  // same sample floor as History and Sessions
const ANOM_HOUR = 3600000;
const ANOM_MAX = 1000;                 // the log is a record, not an archive — weeks, not months

let anomalies = (()=>{ try{ return JSON.parse(localStorage.getItem(ANOM_KEY)||'[]'); }
                       catch(e){ return []; } })();

function anomSave(){ return vlPut(ANOM_KEY, JSON.stringify(anomalies)); }

function anomMedian(vals){
  const s = vals.filter(v=>v!=null && isFinite(v)).slice().sort((a,b)=>a-b);
  if(!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

/*  One continuous move is one event. A coin that keeps clearing the threshold on every rescan
    through a four-hour pump is not four discoveries, and letting it log four times would quietly
    weight the track record toward whatever pumped longest — the same overlapping-sample trap the
    backtest already carries a caveat about.                                                    */
function anomKey(sym, at, dir){
  return sym + '|' + Math.floor(at/86400000) + '|' + dir;
}

/*  The snapshot is taken at flag time and never revised. `price` is the anchor everything is
    scored from, and it is the price at the moment the flag fired — the earliest point a reader
    could have acted on it, exactly as replayCrosses anchors on the close of the cross bar.     */
function anomSnapshot(row, mkt, at){
  const dir = row.move >= 0 ? 'up' : 'down';
  const round = (v, dp) => v==null || !isFinite(v) ? null : +v.toFixed(dp);
  return {
    key: anomKey(row.sym, at, dir),
    type: 'move',                      // the "coiled" early-warning flag shares this log
    sym: row.sym, at, dir,
    price: row.price,
    win: mkt.win,
    move: round(row.move, 2),
    boardMed: round(mkt.med, 2),
    excess: round(row.excess, 2),
    kind: row.kind,                    // 'spec' | 'part' | 'mkt'
    sharpAt: row.sharp ? row.sharp.t : null,
    sharpPct: row.sharp ? round(row.sharp.pct, 2) : null,
    volX: round(row.volX, 2),
    oiChg: row.oi ? round(row.oi.chg, 2) : null,
    flow: row.flow ? row.flow.tag : null,
    funding: isFinite(row.funding) ? round(row.funding*100, 4) : null,
    session: sessionOfHour(new Date(at).getUTCHours()),
    checks: {}                         // hour -> {raw, excess, grade} | {state:'expired'}
  };
}

// returns the entries actually appended, after dedup
function anomAdd(log, rows, mkt, at){
  const seen = new Set(log.map(e=>e.key));
  const added = [];
  rows.forEach(row=>{
    if(row.move==null || !isFinite(row.move)) return;
    const snap = anomSnapshot(row, mkt, at);
    if(seen.has(snap.key)) return;
    seen.add(snap.key);
    added.push(snap);
  });
  return added;
}

// the close of the last bar to have SETTLED by `at` — a bar stamped t closes at t+1h
function anomPriceAt(closes, at){
  let out = null;
  for(const b of closes){
    if(b.t + ANOM_HOUR <= at) out = b.c; else break;
  }
  return out;
}

function anomCovers(closes, at){
  if(!closes || !closes.length) return 'missing';
  if(at > closes[closes.length-1].t + ANOM_HOUR) return 'pending';   // hasn't happened yet
  if(at < closes[0].t + ANOM_HOUR) return 'expired';                 // scrolled off the window
  return 'ok';
}

/*  What the board as a whole did over the same forward window. This is the number that turns
    "it kept going" into something worth knowing — without it, every flag logged on a day the
    whole market rallied would grade as held, and the log would measure the market rather than
    the detector.                                                                             */
function anomBoardReturn(board, from, to){
  const rets = [];
  board.forEach(b=>{
    const p0 = anomPriceAt(b.bars, from), p1 = anomPriceAt(b.bars, to);
    if(p0 && p1 && isFinite(p0) && isFinite(p1)) rets.push((p1-p0)/p0*100);
  });
  return anomMedian(rets);
}

/*  Held / faded / reversed, graded off excess follow-through rather than a bare percentage.

    The band scales with the size of the move that triggered the flag, because a fixed one does
    not survive contact with this board: a coin flagged on +40% giving back 3% has held, while a
    coin flagged on +6% giving back 3% has not. What is being asked is how much of the move was
    handed back, so the thresholds are fractions of the flag's own excess, with a floor so a
    marginal flag cannot produce a hair-trigger band.                                          */
function anomGrade(flagExcess, excessFollow){
  if(excessFollow==null || !isFinite(excessFollow)) return null;
  const unit = Math.max(1, Math.abs(flagExcess||0));
  const giveback = -excessFollow;
  if(giveback < 0.25*unit) return 'held';
  if(giveback < 0.75*unit) return 'faded';
  return 'reversed';
}

/*  Fill in whatever checkpoints the board data now reaches. Called after a scan, because a scan
    already holds 26 hours of hourly closes for the whole liquid board — which is both the coin's
    forward price and the board median, for free and with no extra request. Nothing polls: a flag
    simply stays pending until a later scan can see far enough forward to settle it.

    `board` is [{sym, bars:[{t,o,h,l,c,v}]}]. Returns how many checkpoints were filled.        */
function anomScore(log, board, now){
  const bySym = {};
  board.forEach(b=>{ bySym[b.sym] = b.bars; });
  let filled = 0;

  log.forEach(e=>{
    const bars = bySym[e.sym];
    ANOM_CHECKS.forEach(h=>{
      if(e.checks[h]) return;                          // already settled
      const at = e.at + h*ANOM_HOUR;
      if(at > now) return;                             // not due yet
      if(!bars) return;                                // off the board this scan — try the next

      const cover = anomCovers(bars, at), coverFlag = anomCovers(bars, e.at);
      if(cover==='pending') return;                    // this scan cannot see that far forward
      if(cover==='expired' || coverFlag==='expired'){
        e.checks[h] = {state:'expired'};               // said out loud rather than left blank
        filled++;
        return;
      }
      const c = e.type==='coiled' ? coilCheck(e, bars, h)
                                  : anomMoveCheck(e, bars, board, at);
      if(c){ e.checks[h] = c; filled++; }
    });
  });
  return filled;
}

function anomMoveCheck(e, bars, board, at){
  const p1 = anomPriceAt(bars, at);
  if(p1==null || !isFinite(p1) || !e.price) return null;
  const medRaw = anomBoardReturn(board, e.at, at);
  if(medRaw==null) return {state:'expired'};

  // direction-adjusted throughout: + always means the flag was RIGHT, the same convention
  // replayCrosses / edgeFor / LG_SIGN_NOTE use. This app has been bitten by sign flips twice.
  const rawMove = (p1 - e.price)/e.price*100;
  const raw = e.dir==='up' ? rawMove : -rawMove;
  const med = e.dir==='up' ? medRaw : -medRaw;
  const excess = raw - med;
  return {raw:+raw.toFixed(2), excess:+excess.toFixed(2), grade: anomGrade(e.excess, excess)};
}

/*  Track record, bucketed by what the detector called the move. The question the whole log exists
    to answer is whether "coin-specific" behaves any differently from "market-wide" — so the
    buckets are the classifications, and each reports every checkpoint separately.             */
function anomStats(log){
  const kinds = {};
  const moves = log.filter(e=>e.type!=='coiled');   // coiled flags grade on a different scale
  ['spec','part','mkt'].forEach(kind=>{
    const rows = moves.filter(e=>e.kind===kind);
    const byH = {};
    ANOM_CHECKS.forEach(h=>{
      const scored = rows.map(e=>e.checks[h]).filter(c=>c && c.grade);
      const count = g => scored.filter(c=>c.grade===g).length;
      byH[h] = {
        n: scored.length,
        held: count('held'), faded: count('faded'), reversed: count('reversed'),
        heldPct: scored.length ? Math.round(count('held')/scored.length*100) : null,
        medExcess: scored.length ? +(anomMedian(scored.map(c=>c.excess))).toFixed(2) : null,
        thin: scored.length < ANOM_THIN
      };
    });
    kinds[kind] = {n: rows.length, byH};
  });
  const settled = moves.filter(e=>ANOM_CHECKS.some(h=>e.checks[h] && e.checks[h].grade)).length;
  return {total: moves.length, settled, kinds};
}

/* ---------- the coiled flag ----------
   A move flag says "this already happened". A coiled flag says "this is about to", which is a
   different claim and cannot be scored the same way: it has no direction, so held / faded /
   reversed is meaningless on it. What it actually claims is that the range is unusually tight
   and due to widen — so it is scored on whether the range widened, in either direction, against
   the same coin's own range before the flag. Directionless claim, directionless score.

   Deliberately NOT built on the stochastic. A (5,3,3) normalises the range away —
   (close − lowest low) / (highest high − lowest low) — so it cannot see how wide the range is
   at all, and when the range tightens the shrinking denominator throws %K from 0 to 100 on
   noise. That is a symptom of compression being mistaken for a signal. The stochastic's job
   here starts after the break, reading which way it went; these two jobs stay apart.        */
const COIL_RECENT = 6;        // bars that count as "now"
const COIL_BASE   = 18;       // the bars before those — this coin's own normal
const COIL_TIGHT  = 0.6;      // recent range at or under this fraction of normal is compressed
const COIL_VOL    = 1.4;      // volume this multiple of normal, while price sits still
const COIL_OI     = 10;       // percent of open-interest build that counts as positioning entering
const COIL_MAX    = 8;        // flags logged per sweep — the tightest few, not everything
const COIL_EXPANDED = 2;      // range this multiple of its pre-flag self is a real expansion
/*  Not 1. A range that came out exactly as wide as it went in did not expand at all, and calling
    that "mild" would quietly score every coin that kept sitting still as a partial success.    */
const COIL_MILD     = 1.25;

// mean true range across a slice, as a percentage of price, so coins are comparable
function coilAtrPct(bars, from, to){
  let sum = 0, n = 0;
  for(let i=Math.max(1, from); i<Math.min(bars.length, to); i++){
    const prev = bars[i-1].c, b = bars[i];
    if(!isFinite(prev) || !prev) continue;
    const tr = Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
    sum += tr/prev*100; n++;
  }
  return n ? sum/n : null;
}

// high-to-low span of a slice of bars, as a percentage — the unit expansion is measured in
function coilRange(bars, from, to){
  let hi = -Infinity, lo = Infinity;
  for(let i=Math.max(0, from); i<Math.min(bars.length, to); i++){
    if(bars[i].h > hi) hi = bars[i].h;
    if(bars[i].l < lo) lo = bars[i].l;
  }
  return (isFinite(hi) && isFinite(lo) && lo) ? (hi-lo)/lo*100 : null;
}

// the same span, but bounded by clock time rather than bar index — used after the flag
function coilRangeBetween(bars, from, to){
  let hi = -Infinity, lo = Infinity;
  bars.forEach(b=>{
    if(b.t >= from && b.t < to){
      if(b.h > hi) hi = b.h;
      if(b.l < lo) lo = b.l;
    }
  });
  return (isFinite(hi) && isFinite(lo) && lo) ? (hi-lo)/lo*100 : null;
}

function coilMeanVol(bars, from, to){
  let sum = 0, n = 0;
  for(let i=Math.max(0, from); i<Math.min(bars.length, to); i++){
    const v = bars[i].v;
    if(isFinite(v)){ sum += v; n++; }
  }
  return n ? sum/n : null;
}

/*  Compression against the coin's own recent normal, plus the volume read beside it. Volume
    RISING while the range tightens is the interesting case — that is accumulation happening
    quietly, as opposed to a volume spike, which only ever arrives once the move is already on
    and is therefore confirmation rather than warning.                                       */
function coilRead(bars){
  const n = bars ? bars.length : 0;
  if(n < COIL_RECENT + COIL_BASE) return null;
  const recentFrom = n - COIL_RECENT, baseFrom = n - COIL_RECENT - COIL_BASE;
  const recentAtr = coilAtrPct(bars, recentFrom, n);
  const baseAtr   = coilAtrPct(bars, baseFrom, recentFrom);
  if(!recentAtr || !baseAtr) return null;
  const recentVol = coilMeanVol(bars, recentFrom, n);
  const baseVol   = coilMeanVol(bars, baseFrom, recentFrom);
  const compression = recentAtr/baseAtr;
  return {
    compression: +compression.toFixed(2),
    volRatio: (baseVol > 0 && recentVol != null) ? +(recentVol/baseVol).toFixed(2) : null,
    atrPct: +recentAtr.toFixed(3),
    coiled: compression <= COIL_TIGHT
  };
}

// which of the three signals actually fired — compression is the entry ticket, the others enrich
function coilSignals(c){
  const out = ['compression'];
  if(c.volRatio != null && c.volRatio >= COIL_VOL) out.push('volume');
  if(c.oiChg != null && c.oiChg >= COIL_OI) out.push('oi');
  return out;
}

function coilCandidates(board){
  const out = [];
  board.forEach(b=>{
    const r = coilRead(b.bars);
    if(!r || !r.coiled) return;
    const n = b.bars.length;
    out.push(Object.assign({sym: b.sym, price: b.bars[n-1].c}, r, {
      // the range this coin ran over each checkpoint's length BEFORE the flag — expansion is
      // measured against this, so it has to be captured while it is still knowable
      preRange: {1: coilRange(b.bars, n-1, n),
                 4: coilRange(b.bars, n-4, n),
                 24: coilRange(b.bars, n-24, n)}
    }));
  });
  /*  Rank on how many signals fired FIRST, and only then on tightness. Sorting by compression
      alone ranks dead coins: a range collapses when a coin stops trading, so the tightest names
      on the board are usually the ones nobody is touching. Measured against the live board, the
      top eight by compression all sat at roughly a fifth of their normal volume, while the one
      coin showing the pattern this flag is actually for — range compressed, volume arriving —
      ranked eleventh and never made the log at all.                                          */
  out.forEach(c=>{ c.sigCount = coilSignals(c).length; });
  return out.sort((a,b)=> (b.sigCount - a.sigCount) || (a.compression - b.compression));
}

function coilSnapshot(c, at){
  return {
    key: 'coil|' + anomKey(c.sym, at, 'flat'),
    type: 'coiled',
    sym: c.sym, at, dir: 'flat', price: c.price,
    compression: c.compression, volRatio: c.volRatio, atrPct: c.atrPct,
    oiChg: (c.oiChg == null || !isFinite(c.oiChg)) ? null : +c.oiChg.toFixed(2),
    signals: coilSignals(c),
    preRange: c.preRange,
    session: sessionOfHour(new Date(at).getUTCHours()),
    checks: {}
  };
}

function coilCheck(e, bars, h){
  const pre = e.preRange && e.preRange[h];
  const post = coilRangeBetween(bars, e.at, e.at + h*ANOM_HOUR);
  if(pre == null || post == null || !(pre > 0)) return null;
  const p0 = anomPriceAt(bars, e.at), p1 = anomPriceAt(bars, e.at + h*ANOM_HOUR);
  const move = (p0 && p1) ? (p1-p0)/p0*100 : null;
  const ratio = post/pre;
  return {
    pre: +pre.toFixed(2), post: +post.toFixed(2), ratio: +ratio.toFixed(2),
    move: move == null ? null : +move.toFixed(2),   // which way it broke, for information only
    grade: ratio >= COIL_EXPANDED ? 'expanded' : ratio >= COIL_MILD ? 'mild' : 'quiet'
  };
}

function anomCoiledStats(log){
  const rows = log.filter(e=>e.type==='coiled');
  const byH = {};
  ANOM_CHECKS.forEach(h=>{
    const scored = rows.map(e=>e.checks[h]).filter(c=>c && c.grade);
    const count = g => scored.filter(c=>c.grade===g).length;
    byH[h] = {
      n: scored.length,
      expanded: count('expanded'), mild: count('mild'), quiet: count('quiet'),
      expandedPct: scored.length ? Math.round(count('expanded')/scored.length*100) : null,
      medRatio: scored.length ? +(anomMedian(scored.map(c=>c.ratio))).toFixed(2) : null,
      thin: scored.length < ANOM_THIN
    };
  });
  return {n: rows.length, byH};
}

// the flag covering this coin/day/direction, if one was logged — what the News row tags itself with
function anomFor(log, sym, at, dir){
  const key = anomKey(sym, at, dir);
  return log.find(e=>e.key===key) || null;
}

// ---------- wrappers — the only functions that touch stored state ----------
function anomLogFlags(rows, mkt, at){
  const added = anomAdd(anomalies, rows, mkt, at);
  if(!added.length) return 0;
  anomalies = anomalies.concat(added).slice(-ANOM_MAX);
  anomSave();
  return added.length;
}

function anomScoreFrom(board){
  const filled = anomScore(anomalies, board, Date.now());
  if(filled) anomSave();
  return filled;
}

function anomLogCoiled(cands, at){
  const seen = new Set(anomalies.map(e=>e.key));
  const added = [];
  cands.forEach(c=>{
    const snap = coilSnapshot(c, at);
    if(seen.has(snap.key)) return;
    seen.add(snap.key);
    added.push(snap);
  });
  if(!added.length) return 0;
  anomalies = anomalies.concat(added).slice(-ANOM_MAX);
  anomSave();
  return added.length;
}

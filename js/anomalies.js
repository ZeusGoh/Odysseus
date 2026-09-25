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

/*  Entries of type 'coiled' were the VCP flag, removed with its views; any
    still in a saved log from before are dropped here rather than filtered
    at every reader.                                                        */
let anomalies = (()=>{ try{ return JSON.parse(localStorage.getItem(ANOM_KEY)||'[]').filter(e=>e && e.type!=='coiled'); }
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
    type: 'move',
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
      const c = anomMoveCheck(e, bars, board, at);
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
  const moves = log;
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


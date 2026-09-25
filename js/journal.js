/* journal.js — Trade journal. Every trade you actually take, logged against the
   verdict the app gave it at entry, so the backtest's theoretical edge can be
   checked against what really happened rather than assumed.
   part of Odysseus */

/* ---------- persistence ----------
   Same pattern as alerts.js and news.js: each feature owns its own key rather
   than routing through the watchlist-specific `store` in storage.js.         */
const JOURNAL_KEY = 'vl.journal.v1', JCFG_KEY = 'vl.journal.cfg.v1';

let journal = (()=>{ try{ return JSON.parse(localStorage.getItem(JOURNAL_KEY)||'[]'); }
                      catch(e){ return []; } })();

const jCfg = (()=>{
  let c;
  try{ c = JSON.parse(localStorage.getItem(JCFG_KEY)||'{}'); }catch(e){ c = {}; }
  /*  Older saves priced risk as a percentage of an account balance. That
      balance is gone now — size is told directly, in coins, when a trade is
      logged — but a saved risk-per-trade dollar figure is still a real
      setting worth keeping, so it is derived once from the old pair rather
      than silently reset to blank the first time someone opens the form
      after this changed.                                                   */
  if(!(c.riskUsd > 0) && c.account > 0 && c.riskPct > 0) c.riskUsd = c.account * (c.riskPct/100);
  delete c.account; delete c.riskPct;
  return c;
})();

function jSave(){ return vlPut(JOURNAL_KEY, JSON.stringify(journal)); }
function jSaveCfg(){ return vlPut(JCFG_KEY, JSON.stringify(jCfg)); }

/* ---------- maths ----------
   Risk unit is the distance from entry to invalidation — the same distance
   the position-size formula sizes off. R is how many of those units a price
   has moved, sign-adjusted for direction so + always means the trade is
   working, exactly like the backtest's own convention.                      */
function jRiskUnit(t){ return Math.abs(t.entryPrice - t.invalidation); }

/*  Sizing, expressed the way the trade is actually thought about.

    There is no account balance anywhere in here. The old version took an
    account size and a risk percentage and handed back a coin quantity — two
    numbers standing in for the one that actually mattered, and a stale
    account value silently produced a wrong size with nothing on screen to
    catch it. Size is told directly now, the way a real position is: how
    many coins. Everything else here just says what that quantity is worth —
    the dollar notional, and the dollars actually on the line if the stop is
    hit — the same forward arithmetic the closed-trade detail view already
    used (`jSizeValue`), not a second copy of it.

    A risk-dollar figure still exists as an optional convenience: if you'd
    rather say "I want to risk about $50" than work out the coin quantity
    yourself, `jSizePlan` turns that into a suggested size. It only ever
    fills the box when it is empty — the suggestion is a starting point, the
    quantity you actually type in is the trade.                             */

// the coins that quantity is worth in dollars, and what the stop would cost —
// pure forward arithmetic from a size the person actually typed in
function jSizeValue(size, entry, invalidation){
  if(!(size > 0) || !isFinite(entry) || entry <= 0) return null;
  const notional = size * entry;
  const stop = isFinite(invalidation) ? Math.abs(entry - invalidation) : null;
  const hasStop = stop != null && stop > 0;
  return {
    size, notional,
    stop: hasStop ? stop : null,
    stopPct: hasStop ? stop / entry * 100 : null,
    riskUsd: hasStop ? size * stop : null,
  };
}

/*  The reverse direction: a risk amount and a stop distance, suggesting the
    size that spends exactly that much if the stop is hit. Returned as its
    parts, not one number, so the panel can show its working.               */
function jSizePlan(entry, invalidation, riskUsd){
  const stop = Math.abs(entry - invalidation);
  if(!(stop > 0) || !(riskUsd > 0) || !isFinite(entry) || entry <= 0) return null;
  const size = riskUsd / stop;
  return { stop, riskUsd, size, notional: size * entry, stopPct: stop / entry * 100 };
}

// the suggestion on its own — a risk amount and a stop distance in, a coin quantity out
function jSuggestSize(entry, invalidation, riskUsd){
  const plan = jSizePlan(entry, invalidation, riskUsd);
  return plan ? plan.size : null;
}

function jR(t, atPrice){
  const unit = jRiskUnit(t);
  if(!(unit > 0) || atPrice == null || !isFinite(atPrice)) return null;
  const raw = t.direction === 'short' ? (t.entryPrice - atPrice) : (atPrice - t.entryPrice);
  return raw / unit;
}

function jPct(t, atPrice){
  if(atPrice == null || !isFinite(atPrice)) return null;
  const raw = (atPrice - t.entryPrice) / t.entryPrice * 100;
  return t.direction === 'short' ? -raw : raw;
}

/*  A backdated entry (logging a trade after the fact) still needs the RIGHT
    stochastic zone for that moment, not whatever the panel shows right now —
    otherwise every backdated trade gets tagged with today's condition and
    the whole point of the Patterns breakdown quietly rots. The candle/K/D
    history for the symbol's frame is already sitting in `stoch`, so this
    reads the zone off the last candle at or before the logged time instead
    of trusting assessTrade's live-only read.                               */
function jZoneAt(sym, frame, atTime){
  const st = stoch[sym] && stoch[sym][frame];
  if(!st || !st.candles || !st.candles.length) return null;
  let idx = -1;
  for(let i=0;i<st.candles.length;i++){
    if(st.candles[i].t <= atTime) idx = i; else break;
  }
  if(idx < 0) return null;
  const k = st.k[idx], d = st.d[idx];
  if(k==null || d==null) return null;
  return zoneOf((k+d)/2);
}

/*  The five-frame stochastic picture at the moment of entry.

    Until now a trade recorded only the verdict on the one frame it was taken
    on. That is enough to grade the entry and useless for the question actually
    worth asking later — was the daily agreeing with the 4H, was this taken
    against the weekly — because the answer was never written down. The panel
    shows all five live; none of it survived the trade being logged.

    Reconstructed at the entry timestamp from the same candle arrays jZoneAt
    walks, so a trade logged days later still records the condition it was
    actually taken in rather than today's.                                   */
function jFrameAt(sym, frame, atTime, weight){
  const sd = stoch[sym] && stoch[sym][frame];
  if(!sd || !sd.candles || !sd.candles.length) return null;
  let idx = -1;
  for(let i=0;i<sd.candles.length;i++){
    if(sd.candles[i].t <= atTime) idx = i; else break;
  }
  if(idx < 0) return null;
  const k = sd.k[idx], d = sd.d[idx];
  if(k == null || d == null) return null;

  /*  Cross type and age live in `states`, which only ever describes the latest
      bar. Carrying it onto a backdated snapshot would be inventing history, so
      it is attached only when the entry really does fall on the current bar.  */
  const live = idx === sd.candles.length - 1;
  const st = live && states[sym] ? states[sym][frame] : null;

  return {
    frame, weight: weight == null ? null : weight,
    K: +k.toFixed(1), D: +d.toFixed(1), spread: +(k - d).toFixed(1),
    zone: zoneOf((k + d) / 2),
    side: k >= d ? 'bull' : 'bear',
    signal:   st ? st.type : null,
    settled:  st ? !st.pending : null,
    barsAgo:  st && st.barsAgo != null ? st.barsAgo : null,
    barTime: sd.candles[idx].t
  };
}

function jFramesAt(sym, atTime){
  const out = TFS.map(tf => jFrameAt(sym, tf.key, atTime, tf.weight)).filter(Boolean);
  return out.length ? out : null;
}

/*  How much of the board agreed with the direction taken, weighted the way the
    terminal weights frames. +1 is every frame leaning the trade's way, -1 is
    every frame against it. This is the number that makes "I keep taking 1H
    longs while the weekly is rolling over" answerable.                       */
function jFramesAlignment(frames, direction){
  if(!frames || !frames.length) return null;
  let agree = 0, total = 0;
  for(const f of frames){
    const w = f.weight != null ? f.weight : 1;
    total += w;
    const bull = f.side === 'bull';
    agree += w * ((direction === 'short' ? !bull : bull) ? 1 : -1);
  }
  return total > 0 ? +(agree / total).toFixed(3) : null;
}

function jLastPrice(sym){
  for(const tf of TFS){
    const c = data[sym] && data[sym][tf.key];
    if(c && c.length) return c[c.length-1].c;
  }
  return null;
}

/* ---------- CRUD ---------- */
function jId(){ return 't'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

function jAdd(input){
  const t = {
    id: jId(),
    symbol: input.symbol, frame: input.frame, direction: input.direction,
    entryPrice: input.entryPrice,
    // entryTime is user-editable (logging a trade after the fact should still
    // record when it actually happened, not when it was typed in) — falls
    // back to now only when nothing valid was supplied.
    entryTime: (input.entryTime!=null && isFinite(input.entryTime)) ? input.entryTime : Date.now(),
    invalidation: input.invalidation, size: input.size,
    wave: (input.wave||'').trim(), notes: (input.notes||'').trim(),
    verdict: input.verdict || null,
    // the whole board at entry, not just the frame traded — see jFramesAt
    frames: input.frames || null,
    alignment: input.alignment != null ? input.alignment : null,
    // the analyst call this trade was logged against, if any — a snapshot
    // attached at entry (see jFindSourceReport), never a live reference
    sourceReport: input.sourceReport || null,
    status: 'open', exitPrice: null, exitTime: null, closeNote: ''
  };
  journal = [t, ...journal];
  jSave();
  return t;
}

function jClose(id, exitPrice, exitTime, closeNote){
  const t = journal.find(x=>x.id===id);
  if(!t) return null;
  t.exitPrice = exitPrice;
  t.exitTime = (exitTime!=null && isFinite(exitTime)) ? exitTime : Date.now();
  t.closeNote = (closeNote||'').trim(); t.status = 'closed';
  jSave();
  return t;
}

function jReopen(id){
  const t = journal.find(x=>x.id===id);
  if(!t) return;
  t.status = 'open'; t.exitPrice = null; t.exitTime = null;
  jSave();
}

function jDelete(id){
  journal = journal.filter(x=>x.id!==id);
  jSave();
}

/* ---------- importing trades from outside the app ----------
   The first (only, for now) source is mcp/bybit-import.js, run by hand on
   whichever machine you keep your keys on: it signs into Bybit with a
   read-only API key — never your account password — pulls your closed
   positions, and writes them already shaped like a journal trade to a JSON
   file. This only ever reads that file back in; it never talks to Bybit
   itself, and the browser never sees an API key or secret.

   Every imported trade carries the id Bybit gave the position that produced
   it (`sourceId`), so importing the same file twice — or a file whose window
   overlaps an earlier import — adds nothing twice. A trade logged by hand
   never has a sourceId, so it is never a candidate for this check at all.  */
function jImportTrades(list){
  if(!Array.isArray(list)) return {added:0, skipped:0, error:'not a list of trades'};
  const known = new Set(journal.map(t=>t.sourceId).filter(Boolean));
  const next = [];
  let added = 0, skipped = 0;
  for(const raw of list){
    const sym = raw && raw.symbol ? String(raw.symbol).trim().toUpperCase() : '';
    const direction = raw && (raw.direction==='long' || raw.direction==='short') ? raw.direction : null;
    if(!sym || !direction || !isFinite(raw.entryPrice) || !isFinite(raw.exitPrice)){ skipped++; continue; }
    if(raw.sourceId && known.has(raw.sourceId)){ skipped++; continue; }
    next.push({
      id: jId(),
      symbol: sym, frame: raw.frame || null, direction,
      entryPrice: raw.entryPrice,
      entryTime: isFinite(raw.entryTime) ? raw.entryTime : Date.now(),
      invalidation: isFinite(raw.invalidation) ? raw.invalidation : null,
      size: isFinite(raw.size) ? raw.size : null,
      wave: (raw.wave||'').trim(), notes: (raw.notes||'').trim(),
      verdict: null, frames: null, alignment: null, sourceReport: null,
      status: 'closed',
      exitPrice: raw.exitPrice,
      exitTime: isFinite(raw.exitTime) ? raw.exitTime : raw.entryTime,
      closeNote: (raw.closeNote||'').trim(),
      sourceId: raw.sourceId || null,
    });
    if(raw.sourceId) known.add(raw.sourceId);
    added++;
  }
  if(added){ journal = [...next, ...journal]; jSave(); }
  return {added, skipped};
}

/* ---------- stats ----------
   Split two ways: overall (does the journal show an edge at all) and by the
   grade the verdict engine gave it at entry (does "strong" actually outperform "thin" in
   what you really took — the verdict engine's own claim, checked against
   outcomes rather than assumed).                                            */
function jStats(rows){
  const withR = rows.filter(t=>t.status==='closed').map(t=>jR(t, t.exitPrice)).filter(r=>r!=null);
  if(!withR.length) return null;
  const wins = withR.filter(r=>r>0), losses = withR.filter(r=>r<=0);
  const avg = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
  return {
    n: withR.length,
    winRate: Math.round(wins.length/withR.length*100),
    avgWinR: +avg(wins).toFixed(2),
    avgLossR: +avg(losses).toFixed(2),
    totalR: +withR.reduce((s,x)=>s+x,0).toFixed(2),
    expectancy: +avg(withR).toFixed(2)
  };
}

function jGradeStats(rows){
  const byGrade = {};
  rows.filter(t=>t.status==='closed' && t.verdict && t.verdict.grade).forEach(t=>{
    const r = jR(t, t.exitPrice);
    if(r==null) return;
    (byGrade[t.verdict.grade] = byGrade[t.verdict.grade] || []).push(r);
  });
  return TRADE_ORDER.filter(g=>byGrade[g] && byGrade[g].length).reverse().map(g=>{
    const rs = byGrade[g], wins = rs.filter(r=>r>0).length;
    return {grade:g, n:rs.length, winRate:Math.round(wins/rs.length*100),
             avgR: +(rs.reduce((s,x)=>s+x,0)/rs.length).toFixed(2)};
  });
}

/* ---------- patterns ----------
   The same grouping done six ways: when a trade was taken (hour of day, day
   of week, month) and what condition it was taken in (stochastic zone at
   entry, direction, frame). The point is to make "what time or setup do I
   actually do this wrong" answerable by looking rather than by feel.
   Generic over any key — `keyFn` returns the bucket a trade belongs to (or
   null/undefined to leave it out), `order` fixes the row order for a known,
   finite set of keys; omit it for an open-ended one (months) and rows sort
   chronologically by that bucket's earliest trade instead.               */
function jGroupStats(rows, keyFn, order){
  const groups = {};
  rows.filter(t=>t.status==='closed').forEach(t=>{
    const r = jR(t, t.exitPrice);
    if(r==null) return;
    const key = keyFn(t);
    if(key==null) return;
    if(!groups[key]) groups[key] = {rs:[], firstAt:t.entryTime};
    groups[key].rs.push(r);
    if(t.entryTime < groups[key].firstAt) groups[key].firstAt = t.entryTime;
  });
  let keys = order ? order.filter(k=>groups[k]) : Object.keys(groups).sort((a,b)=>groups[a].firstAt-groups[b].firstAt);
  return keys.map(key=>{
    const rs = groups[key].rs, wins = rs.filter(r=>r>0).length;
    return {key, n:rs.length, winRate:Math.round(wins/rs.length*100),
             avgR: +(rs.reduce((s,x)=>s+x,0)/rs.length).toFixed(2)};
  });
}

const J_HOUR_BLOCKS = ['00–04','04–08','08–12','12–16','16–20','20–24'];
function jHourBlockOf(t){ return J_HOUR_BLOCKS[Math.floor(new Date(t.entryTime).getHours()/4)]; }

const J_WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function jWeekdayOf(t){ return J_WEEKDAYS[(new Date(t.entryTime).getDay()+6)%7]; }

function jMonthOf(t){ return new Date(t.entryTime).toLocaleDateString('en-US',{month:'short',year:'numeric'}); }

const J_ZONES = ['oversold','middle','overbought'];
function jZoneOf(t){ return (t.verdict && t.verdict.zone) || null; }

const J_SOURCE_KEYS = ['Backed by a call', 'No call attached'];
function jSourceKeyOf(t){ return t.sourceReport ? J_SOURCE_KEYS[0] : J_SOURCE_KEYS[1]; }

/*  The one question the analyst's own settled-call record can never answer:
    when you actually traded on one, how did it go. A call graded "right"
    doesn't mean the trade taken off it made money — sizing, entry, and exit
    are yours, not the analyst's — so this reads straight off jSourceReport,
    the snapshot already attached at logging time, rather than looking the
    report back up (which could have moved on, or been removed).

    Not analyst.js's ANALYST_AGREEMENTS — journal.js loads before analyst.js
    (see index.html's script order), so that name doesn't exist yet at the
    time this array is built. A local, duplicate list of the same three
    words is simpler than reordering two files' load order over one
    constant.                                                             */
const J_AGREE_ORDER = ['agree', 'partial', 'clash'];
function jAgreementOf(t){ return t.sourceReport ? (t.sourceReport.agreement || null) : null; }

const J_PATTERNS = [
  {label:'Hour of day (local)', head:'Hour',  keyFn:jHourBlockOf,        order:J_HOUR_BLOCKS},
  {label:'Day of week',         head:'Day',   keyFn:jWeekdayOf,          order:J_WEEKDAYS},
  {label:'Month',               head:'Month', keyFn:jMonthOf,            order:null},
  {label:'Stochastic zone at entry', head:'Zone', keyFn:jZoneOf,         order:J_ZONES},
  {label:'Direction',           head:'Side',  keyFn:t=>t.direction,      order:['long','short']},
  {label:'Frame',               head:'Frame', keyFn:t=>t.frame,          order:TFS.map(x=>x.key)},
  {label:'Backed by an analyst call', head:'Call', keyFn:jSourceKeyOf,   order:J_SOURCE_KEYS},
  {label:'Analyst agreement at entry (backed trades only)', head:'Agreement', keyFn:jAgreementOf, order:J_AGREE_ORDER},
];

/* ---------- refresh ----------
   Pulls fresh candles for exactly the symbols the journal (and the open log
   form, if a valid symbol is typed into it) actually needs — the same pull /
   mergeCandles / analyse idiom scanWatch and alertTick use for the watchlist,
   scoped to journal symbols instead so open positions get live prices without
   requiring every logged coin to also be on the watchlist.                  */
let journalBusy = false;
async function jRefreshPrices(extraSym){
  if(journalBusy) return;
  const syms = new Set(journal.filter(t=>t.status==='open').map(t=>t.symbol));
  if(extraSym) syms.add(extraSym);
  if(!syms.size) return;
  journalBusy = true;
  $('j-refresh') && ($('j-refresh').textContent = 'Refreshing…');
  try{
    for(const sym of syms){
      try{
        const meta = symbolOf(sym);
        const first = !data[sym];
        const res = await Promise.all(TFS.map(tf=>pull(meta, tf, first?BARS:TAIL)));
        if(first) data[sym] = {};
        TFS.forEach((tf,i)=> data[sym][tf.key] = first ? res[i] : mergeCandles(data[sym][tf.key], res[i]));
        analyse(sym);
      }catch(e){ /* that coin's prices just stay stale — the rest still refresh */ }
    }
  } finally {
    journalBusy = false;
    if($('j-refresh')) $('j-refresh').textContent = 'Refresh prices';
    renderJournal();
    jUpdateVerdictPreview();
  }
}

/* ---------- rendering ---------- */
function jAge(ms){
  const mins = Math.max(0, Math.round((Date.now()-ms)/60000));
  if(mins < 60) return mins+'m';
  const hrs = mins/60;
  if(hrs < 24) return hrs.toFixed(hrs<10?1:0)+'h';
  return (hrs/24).toFixed(1)+'d';
}
function jFullTime(ms){
  return new Date(ms).toLocaleString('en-US',
    {weekday:'short', year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
}
function jFmtR(r){ return r==null ? '—' : (r>=0?'+':'')+r.toFixed(2)+'R'; }
function jFmtPct(p){ return p==null ? '—' : (p>=0?'+':'')+p.toFixed(2)+'%'; }
function jGradeCls(g){
  if(g==='strong'||g==='playable') return 'up';
  if(g==='negative'||g==='no edge') return 'down';
  return 'dim';
}
// small inline marker on a row's symbol — backed by an analyst call or not,
// visible without opening the detail panel
function jSrcFlag(t){
  return t.sourceReport ? '<i class="jsrcflag" title="Backed by an analyst call">◆</i>' : '';
}
// small inline marker for a trade that arrived via jImportTrades rather than
// being logged by hand — same idea as jSrcFlag, a different source
function jImportFlag(t){
  return t.sourceId ? '<i class="jimportflag" title="Imported from Bybit">⇩</i>' : '';
}

// the row currently expanded into "closing" mode — an inline exit-price field
// rather than a native prompt(), so it looks and behaves like the rest of Odysseus
let jClosingId = null;

function renderJournalOpen(){
  const rows = journal.filter(t=>t.status==='open');
  const el = $('j-open-rows');
  $('j-open-sub').textContent = rows.length
    ? rows.length+' open position'+(rows.length===1?'':'s')
    : 'positions you are currently in';
  if(!rows.length){ el.innerHTML = '<div class="loading">No open trades logged yet.</div>'; return; }
  el.innerHTML = '';
  rows.forEach(t=>{
    const px = jLastPrice(t.symbol);
    const r = jR(t, px), pct = jPct(t, px);
    const row = document.createElement('div');
    row.className = 'jrow jrow-open';
    if(t.id === jClosingId){
      row.innerHTML =
        '<span class="jsym">'+t.symbol+(t.wave?'<em>'+jEsc(t.wave)+'</em>':'')+'</span>'+
        '<span class="jdir '+(t.direction==='short'?'down':'up')+'">'+t.direction+'</span>'+
        '<span class="jnum">'+fmtUsd(t.entryPrice)+'</span>'+
        '<span class="jnum">'+fmtUsd(t.invalidation)+'</span>'+
        '<span class="jclosewrap" style="grid-column:5 / span 6">'+
          '<input type="text" inputmode="decimal" id="j-exitpx" class="jexitinput" '+
            'placeholder="exit price" value="'+(px!=null?px:'')+'" autocomplete="off">'+
          '<input type="datetime-local" id="j-exittime" class="jexittime" value="'+jNowLocalInput()+'">'+
          '<button class="jconfirm" data-id="'+t.id+'">Confirm close</button>'+
          '<button class="ghost jcancelclose" data-id="'+t.id+'">Cancel</button>'+
        '</span>';
    } else {
      row.innerHTML =
        '<span class="jsym">'+t.symbol+(t.wave?'<em>'+jEsc(t.wave)+'</em>':'')+jSrcFlag(t)+'</span>'+
        '<span class="jdir '+(t.direction==='short'?'down':'up')+'">'+t.direction+'</span>'+
        '<span class="jnum">'+fmtUsd(t.entryPrice)+'</span>'+
        '<span class="jnum">'+fmtUsd(t.invalidation)+'</span>'+
        '<span class="jnum">'+(t.size!=null ? (+t.size).toLocaleString('en-US',{maximumFractionDigits:6}) : '—')+'</span>'+
        '<span class="jgrade '+jGradeCls(t.verdict&&t.verdict.grade)+'">'+(t.verdict ? t.verdict.grade : '—')+'</span>'+
        '<span class="jnum '+(r>0?'up':r<0?'down':'')+'">'+jFmtR(r)+'</span>'+
        '<span class="jnum '+(pct>0?'up':pct<0?'down':'')+'">'+jFmtPct(pct)+'</span>'+
        '<span class="jage" title="Entered '+jEsc(jFullTime(t.entryTime))+'">'+jAge(t.entryTime)+'</span>'+
        '<span class="jactions"><button class="jclose" data-id="'+t.id+'">Close</button>'+
          '<button class="jdel x" data-id="'+t.id+'" title="delete">×</button></span>';
    }
    el.appendChild(row);
  });
}

function jStartClose(id){ jClosingId = id; renderJournalOpen(); $('j-exitpx') && $('j-exitpx').focus(); }
function jCancelClose(){ jClosingId = null; renderJournalOpen(); }
function jConfirmClose(id){
  const raw = $('j-exitpx').value;
  const exitPrice = parseFloat(raw);
  if(!isFinite(exitPrice)){ $('jnote').textContent = 'Not a valid exit price — nothing closed.'; return; }
  const exitTime = jParseLocalInput($('j-exittime').value);
  jClose(id, exitPrice, exitTime);
  jClosingId = null;
  renderJournal();
  $('jnote').textContent = 'Closed.';
}

function renderJournalClosed(){
  const rows = journal.filter(t=>t.status==='closed').sort((a,b)=>b.exitTime-a.exitTime);
  const el = $('j-closed-rows');
  if(!rows.length){ el.innerHTML = '<div class="loading">Nothing closed yet.</div>'; return; }
  el.innerHTML = '';
  rows.forEach(t=>{
    const r = jR(t, t.exitPrice), pct = jPct(t, t.exitPrice);
    const row = document.createElement('div');
    row.className = 'jrow jrow-closed';
    row.innerHTML =
      '<span class="jsym">'+t.symbol+(t.wave?'<em>'+jEsc(t.wave)+'</em>':'')+jSrcFlag(t)+jImportFlag(t)+'</span>'+
      '<span class="jdir '+(t.direction==='short'?'down':'up')+'">'+t.direction+'</span>'+
      '<span class="jnum">'+fmtUsd(t.entryPrice)+'</span>'+
      '<span class="jnum">'+fmtUsd(t.exitPrice)+'</span>'+
      '<span class="jnum">'+(t.size!=null ? (+t.size).toLocaleString('en-US',{maximumFractionDigits:6}) : '—')+'</span>'+
      '<span class="jgrade '+jGradeCls(t.verdict&&t.verdict.grade)+'">'+(t.verdict ? t.verdict.grade : '—')+'</span>'+
      '<span class="jnum '+(r>0?'up':r<0?'down':'')+'">'+jFmtR(r)+'</span>'+
      '<span class="jnum '+(pct>0?'up':pct<0?'down':'')+'">'+jFmtPct(pct)+'</span>'+
      '<span class="jage" title="Entered '+jEsc(jFullTime(t.entryTime))+' — closed '+jEsc(jFullTime(t.exitTime))+'">'+
        new Date(t.exitTime).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</span>'+
      '<span class="jactions"><button class="jmore" data-id="'+t.id+'" aria-expanded="false">Details</button>'+
        '<button class="jreopen" data-id="'+t.id+'">Reopen</button>'+
        '<button class="jdel x" data-id="'+t.id+'" title="delete">×</button></span>';
    el.appendChild(row);

    /*  Rendered up front rather than on demand: the content is small, and
        building it lazily would mean re-deriving it every toggle for no gain
        while making the open/closed state something to track separately.    */
    const det = document.createElement('div');
    det.className = 'jdetail';
    det.id = 'jd-' + t.id;
    det.hidden = true;
    det.innerHTML = jDetailHtml(t);
    el.appendChild(det);
  });
}

/* ---------- the detail behind a closed trade ----------
   The row carries the numbers; everything that explains them — what you wrote
   at the time, when you actually took it, and what the rest of the board was
   doing — was being stored and never shown. This is that.                    */

function jHeldFor(t){
  if(t.entryTime == null || t.exitTime == null) return '—';
  const ms = t.exitTime - t.entryTime;
  if(!(ms > 0)) return '—';
  const h = ms / 36e5;
  if(h < 1)  return Math.round(ms/6e4) + ' min';
  if(h < 48) return h.toFixed(1) + ' h';
  return (h/24).toFixed(1) + ' days';
}

// +1 every frame with the trade, -1 every frame against it
function jAlignWord(a){
  if(a == null) return null;
  if(a >=  0.75) return 'the whole board agreed';
  if(a >=  0.25) return 'most of the board agreed';
  if(a >  -0.25) return 'the board was split';
  if(a >  -0.75) return 'most of the board disagreed';
  return 'the whole board disagreed';
}

function jFramesTable(t){
  if(!t.frames || !t.frames.length){
    return '<p class="jdnote">No multi-frame snapshot was saved for this trade — it was logged '+
           'before the app started recording the whole board at entry. Trades logged from now on '+
           'carry all five frames.</p>';
  }
  const rows = t.frames.map(f=>{
    const withTrade = (t.direction === 'short') ? (f.side === 'bear') : (f.side === 'bull');
    return '<div class="jdfrow">'+
      '<span class="jdfframe">'+jEsc(f.frame)+'</span>'+
      '<span class="jnum">'+f.K.toFixed(1)+' / '+f.D.toFixed(1)+'</span>'+
      '<span class="jnum '+(f.spread>0?'up':f.spread<0?'down':'')+'">'+
        (f.spread>0?'+':'')+f.spread.toFixed(1)+'</span>'+
      '<span class="jdzone z-'+jEsc(String(f.zone))+'">'+jEsc(String(f.zone))+'</span>'+
      '<span class="'+(withTrade?'up':'down')+'">'+(f.side==='bull'?'bull':'bear')+
        (withTrade?' ✓':' ✗')+'</span>'+
      '<span class="jdsig">'+(f.signal ? jEsc(f.signal)+(f.settled===false?' (unsettled)':'') : '—')+'</span>'+
    '</div>';
  }).join('');
  const word = jAlignWord(t.alignment);
  const head = '<div class="jdfrow jdfhead"><span>Frame</span><span>%K / %D</span><span>Spread</span>'+
               '<span>Zone</span><span>Lean</span><span>Cross</span></div>';
  return head + rows + (word
    ? '<p class="jdnote">At entry '+word+' — alignment '+
      (t.alignment>0?'+':'')+t.alignment.toFixed(2)+', weighted the way the terminal weights frames.</p>'
    : '');
}

/*  Was this trade backed by a call, and did it actually agree with it — the
    question the "Backed by a call" pattern row answers in aggregate, spelled
    out for this one trade. Lead time is measured against when the trade was
    logged (not now), since that is the only honest "before or after" here.  */
function jSourceBlock(t){
  const s = t.sourceReport;
  if(!s) return '';
  const dirWord = s.direction === 'bull' ? 'bullish' : 'bearish';
  const tradeSide = t.direction === 'short' ? 'bear' : 'bull';
  const agreed = s.direction === tradeSide;
  const leadH = (t.entryTime - s.at) / 3600e3;
  const lead = isFinite(leadH)
    ? (leadH >= 0
        ? ', '+(leadH < 1 ? Math.round(Math.max(1,leadH*60))+'m' : leadH.toFixed(1)+'h')+' before this trade was logged'
        : ', attached '+Math.abs(leadH).toFixed(1)+'h after — logged first, call attached later')
    : '';
  return '<div class="jdblock"><h4>Analyst call — '+(agreed?'agreed':'went against it')+'</h4>'+
    '<p class="jdnote">'+jEsc(s.headline||'')+'</p>'+
    '<p class="jdnote">Called <b>'+dirWord+'</b>'+
      (s.confidence!=null ? ' at confidence '+Math.round(s.confidence) : '')+
      (s.agreement ? ' ('+jEsc(String(s.agreement))+')' : '')+
      lead+'.</p>'+
  '</div>';
}

function jDetailHtml(t){
  const r = jR(t, t.exitPrice), pct = jPct(t, t.exitPrice);
  const sv = t.size != null ? jSizeValue(t.size, t.entryPrice, t.invalidation) : null;
  const risked = sv ? sv.riskUsd : null;
  const notional = sv ? sv.notional : null;

  const facts = [
    ['Entered',  jFullTime(t.entryTime)],
    ['Closed',   jFullTime(t.exitTime)],
    ['Held',     jHeldFor(t)],
    ['Frame',    t.frame || '—'],
    ['Direction', t.direction],
    ['Entry',    fmtUsd(t.entryPrice)],
    ['Stop',     t.invalidation != null ? fmtUsd(t.invalidation) : '— (none recorded)'],
    ['Exit',     fmtUsd(t.exitPrice)],
    ['Size',     t.size != null ? (+t.size).toLocaleString('en-US',{maximumFractionDigits:8}) : '—'],
    ['Notional at entry', notional != null ? fmtUsd(notional) : '—'],
    ['Risked',   risked != null ? fmtUsd(risked) : '—'],
    ['Result',   jFmtR(r) + '  ·  ' + jFmtPct(pct)]
  ].map(([k,v])=>'<div class="jdfact"><dt>'+jEsc(k)+'</dt><dd>'+jEsc(String(v))+'</dd></div>').join('');

  const v = t.verdict;
  const verdictBlock = v
    ? '<div class="jdblock"><h4>Grade at entry — '+jEsc(String(v.grade))+'</h4>'+
      (v.summary ? '<p class="jdnote">'+jEsc(v.summary)+'</p>' : '')+
      '<p class="jdnote">'+
        (v.hitRate!=null ? 'Historical hit rate '+(v.hitRate*100).toFixed(0)+'%. ' : '')+
        (v.zone!=null ? 'Zone at entry: '+jEsc(String(v.zone))+'. ' : '')+
        (v.divergence ? 'Divergence was present. ' : '')+
      '</p></div>'
    : '<div class="jdblock"><h4>Grade at entry</h4><p class="jdnote">'+
      (t.sourceId
        ? 'Imported from Bybit — the app was not open to grade it at entry.'
        : 'No verdict was captured — that coin\'s data was not loaded when the trade was logged.')+
      '</p></div>';

  const words = [];
  if(t.wave)      words.push('<div class="jdblock"><h4>Wave</h4><p class="jdnote">'+jEsc(t.wave)+'</p></div>');
  if(t.notes)     words.push('<div class="jdblock"><h4>Notes at entry</h4><p class="jdnote">'+jEsc(t.notes)+'</p></div>');
  if(t.closeNote) words.push('<div class="jdblock"><h4>Note on closing</h4><p class="jdnote">'+jEsc(t.closeNote)+'</p></div>');

  return '<div class="jdetail-in">'+
    '<dl class="jdfacts">'+facts+'</dl>'+
    '<div class="jdblock"><h4>Stochastics across frames, at entry</h4>'+jFramesTable(t)+'</div>'+
    verdictBlock + jSourceBlock(t) + words.join('') +
  '</div>';
}

function renderJournalStats(){
  const s = jStats(journal);
  const box = $('j-stats');
  if(!s){ box.innerHTML = '<p class="wnote">Close a trade to start seeing stats.</p>'; }
  else{
    box.innerHTML =
      '<div class="jstat"><b>'+s.n+'</b><span>closed trades</span></div>'+
      '<div class="jstat"><b class="'+(s.winRate>=50?'up':'down')+'">'+s.winRate+'%</b><span>win rate</span></div>'+
      '<div class="jstat"><b class="up">'+jFmtR(s.avgWinR)+'</b><span>avg win</span></div>'+
      '<div class="jstat"><b class="down">'+jFmtR(s.avgLossR)+'</b><span>avg loss</span></div>'+
      '<div class="jstat"><b class="'+(s.totalR>=0?'up':'down')+'">'+jFmtR(s.totalR)+'</b><span>total R</span></div>'+
      '<div class="jstat"><b class="'+(s.expectancy>=0?'up':'down')+'">'+jFmtR(s.expectancy)+'</b><span>expectancy / trade</span></div>';
  }
  const gs = jGradeStats(journal);
  $('j-grade-head').hidden = !gs.length;
  const gbox = $('j-grade-rows');
  gbox.innerHTML = gs.map(g=>
    '<div class="jrow jgraderow">'+
      '<span class="jgrade '+jGradeCls(g.grade)+'">'+g.grade+'</span>'+
      '<span class="jnum">'+g.n+'</span>'+
      '<span class="jnum '+(g.winRate>=50?'up':'down')+'">'+g.winRate+'%</span>'+
      '<span class="jnum '+(g.avgR>=0?'up':'down')+'">'+jFmtR(g.avgR)+'</span>'+
    '</div>').join('');
}

function renderJournalPatterns(){
  const wrap = $('j-patterns');
  if(!wrap) return;
  if(!journal.some(t=>t.status==='closed')){
    wrap.innerHTML = '<p class="wnote">Close a few trades to start seeing patterns by time and setup.</p>';
    return;
  }
  wrap.innerHTML = J_PATTERNS.map(p=>{
    const rows = jGroupStats(journal, p.keyFn, p.order);
    if(!rows.length) return '';
    const body = rows.map(r=>
      '<div class="jrow jgraderow">'+
        '<span>'+jEsc(String(r.key))+'</span>'+
        '<span class="jnum">'+r.n+'</span>'+
        '<span class="jnum '+(r.winRate>=50?'up':'down')+'">'+r.winRate+'%</span>'+
        '<span class="jnum '+(r.avgR>=0?'up':'down')+'">'+jFmtR(r.avgR)+'</span>'+
      '</div>').join('');
    return '<div class="jpatterncard">'+
      '<div class="jpatterntitle">'+p.label+'</div>'+
      '<div class="mrow jgradehead"><span>'+p.head+'</span><span>Trades</span><span>Win rate</span><span>Avg R</span></div>'+
      body+
    '</div>';
  }).join('') || '<p class="wnote">Not enough closed trades yet to break down.</p>';
}

function updateJournalCount(){
  const n = journal.filter(t=>t.status==='open').length;
  const el = $('journal-count');
  if(el) el.textContent = n;
}

function renderJournal(){
  renderJournalOpen();
  renderJournalClosed();
  renderJournalStats();
  renderJournalPatterns();
  updateJournalCount();
}
function jEsc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------- datetime-local helpers ----------
   <input type=datetime-local> reads and writes "YYYY-MM-DDTHH:mm" in the
   browser's own local time, with no timezone in the string — exactly what we
   want, since "what time did I take this" means the user's own wall clock,
   not UTC. new Date(thatString) already parses it as local time, so the only
   real work here is formatting "now" (or an existing timestamp) back into
   that shape for the input's value.                                        */
function jLocalInputValue(ms){
  const d = new Date(ms);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off*60000).toISOString().slice(0,16);
}
function jNowLocalInput(){ const d=new Date(); d.setSeconds(0,0); return jLocalInputValue(d.getTime()); }
function jParseLocalInput(v){
  if(!v) return null;
  const ms = new Date(v).getTime();
  return isFinite(ms) ? ms : null;
}

/* ---------- the log form ---------- */
function jBuildFrameOptions(){
  const sel = $('j-frame');
  sel.innerHTML = TFS.map(t=>'<option value="'+t.key+'">'+t.label+'</option>').join('');
}
let jDir = 'long';
function jSetDir(d){
  jDir = d;
  document.querySelectorAll('#j-dir button').forEach(b=> b.setAttribute('aria-pressed', b.dataset.dir===d));
}

function jUpdateVerdictPreview(){
  const sym = ($('j-sym').value||'').trim().toUpperCase();
  const frame = $('j-frame').value;
  const box = $('j-verdict-preview');
  if(!sym){ box.textContent = ''; return; }
  if(!(states[sym] && states[sym][frame])){
    box.textContent = 'No data loaded yet for '+sym+' on '+frame+' — hit Refresh prices, or open it in Terminal first.';
    box.className = 'jverdict dim';
    return;
  }
  const a = assessTrade(sym, frame);
  const entryTime = jParseLocalInput($('j-entrytime').value);
  const backdated = entryTime != null && (Date.now() - entryTime) > 3*3600e3; // >3h ago
  box.textContent = 'Verdict at entry: '+a.grade.toUpperCase()+(a.summary ? ' — '+a.summary : '')+
    (backdated ? ' (grade reflects the current read — only the zone is reconstructed for a backdated time)' : '');
  box.className = 'jverdict '+jGradeCls(a.grade);
}

/* ---------- the analyst call behind a trade ----------
   The journal and the Analyst view have always been blind to each other —
   this is the one link between them, and it stays a display-only one: a
   snapshot of a report attached to a trade, never anything fed back into
   either analyst. `analystReports`/`analystLatestFor`/`analystStale` are
   globals from analyst.js, referenced here only inside functions that run
   on user interaction — by the time any of these actually fire, both
   scripts have finished loading, same as journal.js already leans on
   `stoch`/`states`/`assessTrade` from other files (see the file header).  */

// the draft state for whichever form is currently open — a snapshot of the
// report, not a live reference, so it keeps saying what the call was at the
// moment it was attached even if that report is edited or removed later
let jDraftSource = null;
let jSourceForSym = null;   // which symbol jDraftSource reflects — a lookup only re-fires when this changes

// the newest live, directional call for a symbol — same filter analystShortlist
// uses (fresh, and an actual bull/bear lean rather than split or neutral),
// because a call with no direction is not one a trade can be graded against
function jFindSourceReport(sym){
  if(typeof analystReports === 'undefined' || !sym) return null;
  const r = analystLatestFor(analystReports, sym);
  if(!r || analystStale(r)) return null;
  if(r.direction !== 'bull' && r.direction !== 'bear') return null;
  return {at: r.at, symbol: r.symbol, direction: r.direction, agreement: r.agreement,
          confidence: r.confidence, headline: r.headline};
}

// re-looks-up the attached call only when the symbol box actually changed —
// typing in the middle of a symbol re-checks on every keystroke, same cost
// as jUpdateVerdictPreview already pays on the same field
function jSyncSource(){
  const sym = ($('j-sym').value||'').trim().toUpperCase();
  if(sym === jSourceForSym) return;
  jSourceForSym = sym;
  jDraftSource = jFindSourceReport(sym);
  jRenderSource();
}

function jRenderSource(){
  const el = $('j-source');
  if(!el) return;
  if(!jDraftSource){
    el.innerHTML = '<span class="jdnote">No analyst call attached'+
      (jSourceForSym ? ' for '+jEsc(jSourceForSym) : '')+'.</span>';
    return;
  }
  const s = jDraftSource;
  const dirWord = s.direction === 'bull' ? 'bullish' : 'bearish';
  el.innerHTML =
    '<span class="jsrctag '+(s.direction==='bull'?'up':'down')+'">'+dirWord+'</span> '+
    jEsc(s.headline||'')+
    (s.confidence!=null ? ' <em>('+Math.round(s.confidence)+')</em>' : '')+
    ' <button type="button" class="ghost jsrcunlink" id="j-source-unlink">Unlink</button>';
  const btn = $('j-source-unlink');
  if(btn) btn.onclick = ()=>{ jDraftSource = null; jRenderSource(); };
}

/*  prefill fills the form in; it never saves. The gap between a filled form and
    a logged trade is deliberate: it is what keeps the journal a record of what
    the user actually did rather than of what something else proposed.        */
function jOpenForm(prefill){
  const p = prefill || {};
  $('j-sym').value = p.symbol || active || '';
  jBuildFrameOptions();
  $('j-frame').value = p.frame || (shown && shown[0]) || TFS[2].key;
  jSetDir(p.direction === 'short' ? 'short' : 'long');
  const sym = ($('j-sym').value||'').trim().toUpperCase();
  // a live position's own entry beats the last price the app happens to hold
  const px = (p.entryPrice != null && isFinite(p.entryPrice)) ? p.entryPrice : jLastPrice(sym);
  $('j-entry').value = px!=null ? px : '';
  $('j-entrytime').value = p.entryTime!=null ? jLocalInputValue(p.entryTime) : jNowLocalInput();
  // a suggested invalidation is a number to check, not one to trust — but an
  // empty box is the field people most often leave wrong, so it gets filled
  $('j-inval').value = (p.invalidation != null && isFinite(p.invalidation)) ? p.invalidation : '';
  $('j-size').value = (p.size != null && isFinite(p.size)) ? p.size : '';
  $('j-wave').value = p.wave || '';
  $('j-notes').value = p.notes || '';
  $('j-riskusd').value = jCfg.riskUsd || '';
  // an explicit attach (from an analyst card's "Log this trade") wins outright;
  // otherwise this looks up the newest live call for whatever symbol landed in
  // the box, exactly what typing that symbol in by hand would also find
  jSourceForSym = sym;
  jDraftSource = p.sourceReport !== undefined ? p.sourceReport : jFindSourceReport(sym);
  jRenderSource();
  $('j-form').hidden = false;
  jRenderSizeWork();
  // with entry and invalidation both present and a risk amount saved from last
  // time, a suggested size fills in rather than the box arriving blank
  jFillSuggestedSize();
  jUpdateVerdictPreview();
  $('j-sym').focus();
}

// trims a quantity to something readable without losing a small coin size
function jNum(n, dp){
  if(n == null || !isFinite(n)) return '—';
  return n.toFixed(dp == null ? 6 : dp).replace(/\.?0+$/, '');
}

/*  Shows what the numbers on screen actually mean, every time they change.
    Size, typed directly, is the trade — so it leads: if there is one, this
    states what it is worth and what it risks, forward arithmetic only, the
    same jSizeValue the closed-trade detail view uses. Only when the size box
    is empty does it fall back to describing what a risk amount would buy,
    and says plainly that that is a suggestion, not the plan.               */
function jRenderSizeWork(){
  const el = $('j-sizework');
  if(!el) return;
  const entry = parseFloat($('j-entry').value), inval = parseFloat($('j-inval').value);
  const size = parseFloat($('j-size').value);
  const riskUsd = parseFloat($('j-riskusd').value);

  if(size > 0){
    const unit = size === 1 ? 'coin' : 'coins';
    if(!isFinite(entry) || entry <= 0){
      el.textContent = jNum(size)+' '+unit+'. Enter a price to see what that is worth.';
      el.className = 'jsizework';
      return;
    }
    const sv = jSizeValue(size, entry, inval);
    let s = jNum(size)+' '+unit+' ≈ '+fmtUsd(sv.notional)+' notional';
    s += sv.riskUsd != null
      ? ', risking '+fmtUsd(sv.riskUsd)+' over a stop of '+jNum(sv.stop, 6)+' ('+sv.stopPct.toFixed(2)+'%)'
      : ' — set an invalidation to see what it risks';
    el.textContent = s + '.';
    el.className = 'jsizework';
    return;
  }

  if(!(riskUsd > 0)){
    el.textContent = 'Type a size, in coins, to see its dollar value — or set a risk amount below and a size will be suggested.';
    el.className = 'jsizework'; return;
  }
  if(!isFinite(entry) || !isFinite(inval)){
    el.textContent = 'Risking '+fmtUsd(riskUsd)+' per trade. Enter a price and an invalidation to suggest a size.';
    el.className = 'jsizework';
    return;
  }
  const p = jSizePlan(entry, inval, riskUsd);
  if(!p){ el.textContent = 'Invalidation can’t equal entry — there is no stop distance to size against.';
          el.className = 'jsizework warn'; return; }

  el.textContent = 'Risking '+fmtUsd(p.riskUsd)+' over a stop of '+jNum(p.stop, 6)+
    ' ('+p.stopPct.toFixed(2)+'%) suggests a size of '+jNum(p.size)+' ≈ '+fmtUsd(p.notional)+' notional.';
  el.className = 'jsizework';
}

function jFillSuggestedSize(){
  const entry = parseFloat($('j-entry').value), inval = parseFloat($('j-inval').value);
  const riskUsd = parseFloat($('j-riskusd').value);
  if(isFinite(entry) && isFinite(inval) && !$('j-size').value){
    const p = jSizePlan(entry, inval, riskUsd);
    if(p) $('j-size').value = jNum(p.size);
  }
  jRenderSizeWork();
}

function jSaveForm(){
  const sym = ($('j-sym').value||'').trim().toUpperCase();
  const frame = $('j-frame').value;
  const entryPrice = parseFloat($('j-entry').value);
  const invalidation = parseFloat($('j-inval').value);
  const size = $('j-size').value.trim() ? parseFloat($('j-size').value) : null;
  if(!sym || !isFinite(entryPrice) || !isFinite(invalidation)){
    $('jnote').textContent = 'Coin, entry price and invalidation are required.';
    return;
  }
  if(entryPrice === invalidation){
    $('jnote').textContent = 'Invalidation can’t equal entry — there would be no risk unit to size or score against.';
    return;
  }
  const savedRisk = parseFloat($('j-riskusd').value);
  if(savedRisk > 0){ jCfg.riskUsd = savedRisk; jSaveCfg(); }

  const entryTime = jParseLocalInput($('j-entrytime').value);

  const verdict = (states[sym] && states[sym][frame]) ? assessTrade(sym, frame) : null;
  // zone is reconstructed at the logged time (see jZoneAt) rather than taken
  // from the live read, so a backdated entry still lands in the right bucket
  const at = entryTime != null ? entryTime : Date.now();
  const histZone = jZoneAt(sym, frame, at);
  const frames = jFramesAt(sym, at);
  jAdd({
    symbol: sym, frame, direction: jDir, entryPrice, entryTime, invalidation, size,
    wave: $('j-wave').value, notes: $('j-notes').value,
    frames, alignment: jFramesAlignment(frames, jDir),
    sourceReport: jDraftSource,
    // the fuller "stochastic condition" at entry, not just the headline grade —
    // zone in particular is what the Patterns breakdown groups by
    // states and stoch are populated together (see analyse()), so a live
    // verdict and a reconstructable zone rise and fall together — no case
    // where one exists without the other, so a single null covers both.
    verdict: verdict ? {grade:verdict.grade, score:verdict.score, hitRate:verdict.hitRate,
                        signals:verdict.signals, summary:verdict.summary,
                        zone: histZone != null ? histZone : (verdict.zone || null),
                        divergence: !!(verdict.divergence && verdict.divergence.present),
                        btc: verdict.btc || null, ema200: verdict.ema200 || null} : null
  });
  $('j-form').hidden = true;
  $('jnote').textContent = 'Logged.';
  jDraftSource = null; jSourceForSym = null;
  renderJournal();
}


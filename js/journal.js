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

const jCfg = Object.assign({account:1000, riskPct:1},
  (()=>{ try{ return JSON.parse(localStorage.getItem(JCFG_KEY)||'{}'); }catch(e){ return {}; } })());

function jSave(){ return vlPut(JOURNAL_KEY, JSON.stringify(journal)); }
function jSaveCfg(){ return vlPut(JCFG_KEY, JSON.stringify(jCfg)); }

/* ---------- maths ----------
   Risk unit is the distance from entry to invalidation — the same distance
   the position-size formula sizes off. R is how many of those units a price
   has moved, sign-adjusted for direction so + always means the trade is
   working, exactly like the backtest's own convention.                      */
function jRiskUnit(t){ return Math.abs(t.entryPrice - t.invalidation); }

function jSuggestSize(entry, invalidation, account, riskPct){
  const unit = Math.abs(entry - invalidation);
  if(!(unit > 0) || !(account > 0) || !(riskPct > 0)) return null;
  return (account * (riskPct/100)) / unit;
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

/* ---------- stats ----------
   Split two ways: overall (does the journal show an edge at all) and by the
   grade Logan gave it at entry (does "strong" actually outperform "thin" in
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

const J_PATTERNS = [
  {label:'Hour of day (local)', head:'Hour',  keyFn:jHourBlockOf,        order:J_HOUR_BLOCKS},
  {label:'Day of week',         head:'Day',   keyFn:jWeekdayOf,          order:J_WEEKDAYS},
  {label:'Month',               head:'Month', keyFn:jMonthOf,            order:null},
  {label:'Stochastic zone at entry', head:'Zone', keyFn:jZoneOf,         order:J_ZONES},
  {label:'Direction',           head:'Side',  keyFn:t=>t.direction,      order:['long','short']},
  {label:'Frame',               head:'Frame', keyFn:t=>t.frame,          order:TFS.map(x=>x.key)},
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
        '<span class="jsym">'+t.symbol+(t.wave?'<em>'+jEsc(t.wave)+'</em>':'')+'</span>'+
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
      '<span class="jsym">'+t.symbol+(t.wave?'<em>'+jEsc(t.wave)+'</em>':'')+'</span>'+
      '<span class="jdir '+(t.direction==='short'?'down':'up')+'">'+t.direction+'</span>'+
      '<span class="jnum">'+fmtUsd(t.entryPrice)+'</span>'+
      '<span class="jnum">'+fmtUsd(t.exitPrice)+'</span>'+
      '<span class="jnum">'+(t.size!=null ? (+t.size).toLocaleString('en-US',{maximumFractionDigits:6}) : '—')+'</span>'+
      '<span class="jgrade '+jGradeCls(t.verdict&&t.verdict.grade)+'">'+(t.verdict ? t.verdict.grade : '—')+'</span>'+
      '<span class="jnum '+(r>0?'up':r<0?'down':'')+'">'+jFmtR(r)+'</span>'+
      '<span class="jnum '+(pct>0?'up':pct<0?'down':'')+'">'+jFmtPct(pct)+'</span>'+
      '<span class="jage" title="Entered '+jEsc(jFullTime(t.entryTime))+' — closed '+jEsc(jFullTime(t.exitTime))+'">'+
        new Date(t.exitTime).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</span>'+
      '<span class="jactions"><button class="jreopen" data-id="'+t.id+'">Reopen</button>'+
        '<button class="jdel x" data-id="'+t.id+'" title="delete">×</button></span>';
    el.appendChild(row);
  });
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

function jOpenForm(prefill){
  const p = prefill || {};
  $('j-sym').value = p.symbol || active || '';
  jBuildFrameOptions();
  $('j-frame').value = p.frame || (shown && shown[0]) || TFS[2].key;
  jSetDir('long');
  const px = jLastPrice(($('j-sym').value||'').trim().toUpperCase());
  $('j-entry').value = px!=null ? px : '';
  $('j-entrytime').value = p.entryTime!=null ? jLocalInputValue(p.entryTime) : jNowLocalInput();
  $('j-inval').value = '';
  $('j-size').value = '';
  $('j-wave').value = '';
  $('j-notes').value = '';
  $('j-account').value = jCfg.account;
  $('j-riskpct').value = jCfg.riskPct;
  $('j-form').hidden = false;
  jUpdateVerdictPreview();
  $('j-sym').focus();
}

function jFillSuggestedSize(){
  const entry = parseFloat($('j-entry').value), inval = parseFloat($('j-inval').value);
  const account = parseFloat($('j-account').value), riskPct = parseFloat($('j-riskpct').value);
  if(!isFinite(entry) || !isFinite(inval)) return;
  const size = jSuggestSize(entry, inval, account, riskPct);
  if(size != null && !$('j-size').value) $('j-size').value = size.toFixed(6).replace(/\.?0+$/,'');
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
  jCfg.account = parseFloat($('j-account').value) || jCfg.account;
  jCfg.riskPct = parseFloat($('j-riskpct').value) || jCfg.riskPct;
  jSaveCfg();

  const entryTime = jParseLocalInput($('j-entrytime').value);

  const verdict = (states[sym] && states[sym][frame]) ? assessTrade(sym, frame) : null;
  // zone is reconstructed at the logged time (see jZoneAt) rather than taken
  // from the live read, so a backdated entry still lands in the right bucket
  const histZone = jZoneAt(sym, frame, entryTime != null ? entryTime : Date.now());
  jAdd({
    symbol: sym, frame, direction: jDir, entryPrice, entryTime, invalidation, size,
    wave: $('j-wave').value, notes: $('j-notes').value,
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
  renderJournal();
}


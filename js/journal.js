/* journal.js — Trade journal. Every trade you actually take, logged against the
   verdict the app gave it at entry, so the backtest's theoretical edge can be
   checked against what really happened rather than assumed.
   part of VL */

/* ---------- persistence ----------
   Same pattern as alerts.js and news.js: each feature owns its own key rather
   than routing through the watchlist-specific `store` in storage.js.         */
const JOURNAL_KEY = 'vl.journal.v1', JCFG_KEY = 'vl.journal.cfg.v1';

let journal = (()=>{ try{ return JSON.parse(localStorage.getItem(JOURNAL_KEY)||'[]'); }
                      catch(e){ return []; } })();

const jCfg = Object.assign({account:1000, riskPct:1},
  (()=>{ try{ return JSON.parse(localStorage.getItem(JCFG_KEY)||'{}'); }catch(e){ return {}; } })());

function jSave(){ try{ localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal)); return true; }catch(e){ return false; } }
function jSaveCfg(){ try{ localStorage.setItem(JCFG_KEY, JSON.stringify(jCfg)); return true; }catch(e){ return false; } }

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
    entryPrice: input.entryPrice, entryTime: Date.now(),
    invalidation: input.invalidation, size: input.size,
    wave: (input.wave||'').trim(), notes: (input.notes||'').trim(),
    verdict: input.verdict || null,
    status: 'open', exitPrice: null, exitTime: null, closeNote: ''
  };
  journal = [t, ...journal];
  jSave();
  return t;
}

function jClose(id, exitPrice, closeNote){
  const t = journal.find(x=>x.id===id);
  if(!t) return null;
  t.exitPrice = exitPrice; t.exitTime = Date.now();
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
function jFmtR(r){ return r==null ? '—' : (r>=0?'+':'')+r.toFixed(2)+'R'; }
function jFmtPct(p){ return p==null ? '—' : (p>=0?'+':'')+p.toFixed(2)+'%'; }
function jGradeCls(g){
  if(g==='strong'||g==='playable') return 'up';
  if(g==='negative'||g==='no edge') return 'down';
  return 'dim';
}

// the row currently expanded into "closing" mode — an inline exit-price field
// rather than a native prompt(), so it looks and behaves like the rest of VL
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
        '<span class="jclosewrap" style="grid-column:5 / span 5">'+
          '<input type="text" inputmode="decimal" id="j-exitpx" class="jexitinput" '+
            'placeholder="exit price" value="'+(px!=null?px:'')+'" autocomplete="off">'+
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
        '<span class="jage">'+jAge(t.entryTime)+'</span>'+
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
  jClose(id, exitPrice);
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
      '<span class="jage">'+new Date(t.exitTime).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'</span>'+
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

function updateJournalCount(){
  const n = journal.filter(t=>t.status==='open').length;
  const el = $('journal-count');
  if(el) el.textContent = n;
}

function renderJournal(){
  renderJournalOpen();
  renderJournalClosed();
  renderJournalStats();
  updateJournalCount();
}
function jEsc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

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
  box.textContent = 'Verdict at entry: '+a.grade.toUpperCase()+(a.summary ? ' — '+a.summary : '');
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

  const verdict = (states[sym] && states[sym][frame]) ? assessTrade(sym, frame) : null;
  jAdd({
    symbol: sym, frame, direction: jDir, entryPrice, invalidation, size,
    wave: $('j-wave').value, notes: $('j-notes').value,
    verdict: verdict ? {grade:verdict.grade, score:verdict.score, hitRate:verdict.hitRate,
                        signals:verdict.signals, summary:verdict.summary} : null
  });
  $('j-form').hidden = true;
  $('jnote').textContent = 'Logged.';
  renderJournal();
}


/* ui-anomalies.js — The detector's own track record, shown inside the News view: a held/faded/
   reversed tag on each flagged row, the record broken down by what the detector called the move,
   and the raw log underneath it.
   part of Odysseus */

/*  Move flags grade held / faded / reversed. Every grade goes through anomPill,
    so every grade belongs here — one missing from this map renders as
    class="anompill undefined", which is invisible until the day it isn't.   */
const ANOM_GRADE_TONE = {held:'up', faded:'dim', reversed:'down'};

/*  Newest sweep first, but the order WITHIN a sweep left alone — the log is written in rank
    order, so a plain reverse() would stand each batch on its head and bury the flag the ranking
    worked to put at the top. Array.sort is stable, which is what keeps ties in place.        */
function anomNewestFirst(rows){
  return [...rows].sort((a,b)=> b.at - a.at);
}
const ANOM_KIND_LABEL = {spec:'Coin-specific', part:'Amplified', mkt:'Market-wide'};

function anomPill(grade){
  if(!grade) return '';
  return '<span class="anompill '+(ANOM_GRADE_TONE[grade]||'dim')+'">'+grade+'</span>';
}

/*  The tag a News row wears. It reports the earliest checkpoint that has actually settled, so a
    flag says something an hour after it fires rather than staying blank for a day — the label
    names which checkpoint it is, because "held" at +1h and "held" at +24h are not the same claim. */
function anomRowTag(sym, at, dir){
  const e = anomFor(anomalies, sym, at, dir);
  if(!e) return '';
  for(const h of ANOM_CHECKS){
    const c = e.checks[h];
    if(c && c.grade)
      return '<span class="anomtag" title="'+nvEsc(anomTagTitle(e))+'">'+
             anomPill(c.grade)+'<em>+'+h+'h</em></span>';
  }
  return '<span class="anomtag" title="Logged — no checkpoint has settled yet."><em>logged</em></span>';
}

function anomTagTitle(e){
  const lines = ['Flagged '+nvAgo(e.at)+' at '+fmtUsd(e.price)+' — '+
                 (ANOM_KIND_LABEL[e.kind]||e.kind)+', '+e.move+'% on a board doing '+e.boardMed+'%.'];
  ANOM_CHECKS.forEach(h=>{
    const c = e.checks[h];
    if(!c) lines.push('+'+h+'h: not settled yet');
    else if(c.state==='expired') lines.push('+'+h+'h: missed — the scan window had rolled past it');
    else lines.push('+'+h+'h: '+c.grade+' · '+(c.raw>0?'+':'')+c.raw+'% raw, '+
                    (c.excess>0?'+':'')+c.excess+'% beyond the board');
  });
  lines.push('Excess is the number that matters: raw minus what the whole board did over the '+
             'same hours. Positive always means the flag was right.');
  return lines.join('\n');
}

function anomPctCell(v){
  if(v==null) return '<span class="hnum dim">·</span>';
  const cls = v>=55 ? 'up' : v<=45 ? 'down' : 'dim';
  return '<span class="hnum '+cls+'">'+v+'%</span>';
}

function renderAnomTrack(){
  const box = $('anomrows');
  if(!box) return;
  const s = anomStats(anomalies);
  if(!s.total){
    box.innerHTML = '<div class="loading">Nothing logged yet. Run a scan and the flags '+
                    'it raises get written down here, then scored an hour later.</div>';
    return;
  }
  box.innerHTML = ['spec','part','mkt'].map(kind=>{
    const k = s.kinds[kind];
    const lead = k.byH[ANOM_CHECKS[0]];
    return '<div class="mrow anomrow'+(lead.thin?' thinsample':'')+'" title="'+
      nvEsc(k.n+' flags classified '+(ANOM_KIND_LABEL[kind]||kind)+'. '+
        (lead.thin ? 'Under '+ANOM_THIN+' scored flags — a rumour, not a record.'
                   : 'Past the '+ANOM_THIN+'-flag floor.'))+'">'+
      '<div class="anomlab">'+ANOM_KIND_LABEL[kind]+
        '<span class="tspan">'+k.n+' flagged</span></div>'+
      ANOM_CHECKS.map(h=>{
        const c = k.byH[h];
        return '<div>'+anomPctCell(c.heldPct)+'<span class="samp">n='+c.n+'</span></div>';
      }).join('')+
      '</div>';
  }).join('');
}

function renderAnomLog(){
  const box = $('anomlog');
  if(!box) return;
  const moves = anomalies;
  if(!moves.length){ box.innerHTML = '<div class="loading">No flags logged yet.</div>'; return; }
  box.innerHTML = anomNewestFirst(moves).slice(0, 25).map(e=>{
    const tone = e.dir==='up' ? 'up' : 'down';
    return '<div class="mrow anomlogrow" title="'+nvEsc(anomTagTitle(e))+'">'+
      '<div class="anomsym">'+nvIcon(e.sym)+'<b>'+nvEsc(e.sym)+'</b>'+
        '<em>'+nvAgo(e.at)+'</em></div>'+
      '<div class="hnum '+tone+'">'+(e.move>0?'+':'')+e.move+'%</div>'+
      '<div class="hnum dim">'+(e.excess>0?'+':'')+e.excess+'%</div>'+
      '<div class="anomkind">'+(ANOM_KIND_LABEL[e.kind]||e.kind)+'</div>'+
      ANOM_CHECKS.map(h=>{
        const c = e.checks[h];
        if(!c) return '<div><span class="hnum dim">·</span></div>';
        if(c.state==='expired') return '<div><span class="thin">missed</span></div>';
        return '<div>'+anomPill(c.grade)+'</div>';
      }).join('')+
      '</div>';
  }).join('');
}

function renderAnomPanels(){
  // the track record and the flag log live in Anomaly History; this view keeps
  // the live sweep and nothing else
}

function renderAnomHistory(){
  renderAnomTrack();
  renderAnomLog();
  const el = $('ah-count');
  if(el){
    const moves = anomalies.length;
    el.textContent = moves ? moves+' flag'+(moves===1?'':'s')+' logged' : 'nothing logged yet';
  }
  const note = $('anomnote');
  if(!note) return;   // the count above must not depend on this node existing
  const s = anomStats(anomalies);
  note.textContent =
    s.settled+' of '+s.total+' flags have at least one settled checkpoint. Held/faded/reversed is '+
    'read off excess follow-through — the move minus what the whole board did over the same hours — '+
    'so a flag raised on a day everything rallied does not get credit for the rally. A flag caught '+
    'mid-move can look like it held simply because the move was still running when the hour came '+
    'round, which is why there are three checkpoints rather than one. Rows under '+ANOM_THIN+
    ' scored flags are dimmed. This is a research log: nothing here is a trade, and nothing here '+
    'has a stop.';
}

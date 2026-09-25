/* ui-sessions.js — Sessions view. Today's live read across Asia / London / New York, plus
   how often each stage of that sequence has actually played out on this coin's loaded 1H
   history.
   part of Odysseus */

function sessBadge(label, state, tone){
  const cls = tone==='up' ? 'up' : tone==='down' ? 'down' : 'dim';
  return '<div class="sessstage"><span class="sesslab">'+label+'</span>'+
         '<span class="sessval '+cls+'">'+state+'</span></div>';
}

// `sym` and `box` default to the view's own, so the Bitcoin desk can draw the
// same read for BTC into its own panel without a second copy of any of this
function renderSessionsLive(sym, box){
  sym = sym || active;
  box = box || $('sess-live');
  const live = sessionsLive(sym);
  if(!live){ box.innerHTML = '<div class="loading">Not enough 1H history loaded yet.</div>'; return; }

  const parts = [];
  if(live.asia){
    const a = live.asia;
    const held = a.held===null ? 'no lookback yet' : a.held ? 'held' : 'broke range';
    parts.push(sessBadge('Asia', (a.complete?'':(a.n+'/8 bars · '))+fmtUsd(a.low)+'–'+fmtUsd(a.high)+' · '+held,
      a.held===null ? null : a.held ? 'up' : 'down'));
  } else {
    parts.push(sessBadge('Asia', 'not started', null));
  }
  if(live.london){
    const l = live.london;
    const dirWord = l.breakDir==='up' ? 'broke up' : l.breakDir==='down' ? 'broke down'
                  : l.breakDir==='ambiguous' ? 'ambiguous bar' : 'holding inside Asia';
    parts.push(sessBadge('London', (l.complete?'':(l.n+'/5 bars · '))+dirWord,
      l.breakDir==='up' ? 'up' : l.breakDir==='down' ? 'down' : null));
  } else if(live.asia){
    parts.push(sessBadge('London', 'not started', null));
  }
  if(live.london && (live.london.breakDir==='up'||live.london.breakDir==='down')){
    if(live.ny){
      const n = live.ny;
      const bits = [];
      bits.push(n.swept ? 'swept London\'s '+(live.london.breakDir==='up'?'low':'high')+' first' : 'no sweep');
      bits.push(n.continued ? 'continued '+live.london.breakDir : 'has not continued yet');
      parts.push(sessBadge('New York', (n.complete?'':(n.n+'/11 bars · '))+bits.join(' · '),
        n.continued ? live.london.breakDir : null));
    } else {
      parts.push(sessBadge('New York', 'not started', null));
    }
  }
  box.innerHTML = '<div class="sessnow">Current session: <b>'+
    ({asia:'Asia',london:'London',ny:'New York'})[live.current]+'</b></div>'+
    '<div class="sessstages">'+parts.join('')+'</div>';
}

function sessRateRow(label, sub, rate, thin, n){
  return '<div class="mrow sessrow'+(thin?' thinsample':'')+'" title="'+
    (thin ? 'Only '+n+' days behind this — too few to lean on.' : n+' days behind this reading.')+'">'+
    '<div class="sessrowlab">'+label+'<span class="tspan">'+sub+'</span></div>'+
    '<div class="hnum dim">'+n+'</div>'+
    '<div>'+(rate==null ? '<span class="hnum dim">·</span>' : winCell(rate))+'</div>'+
    '</div>';
}

function renderSessionsStats(sym, box, sweep, note){
  sym = sym || active;
  box = box || $('sess-stats');
  sweep = sweep || $('sess-sweep');
  if(note === undefined) note = $('sessnote');
  const s = sessionsFor(sym);
  if(!s){
    box.innerHTML = '<div class="loading">Not enough closed sessions in the loaded history yet.</div>';
    if(note) note.textContent = '';
    return;
  }
  box.innerHTML =
    sessRateRow('Asia holds', 'inside the previous three sessions\' range', s.asia.heldRate, s.asia.thin, s.asia.n) +
    sessRateRow('London expands', 'breaks out of Asia\'s range ('+s.london.upRate+'% up · '+s.london.downRate+'% down)',
                s.london.expansionRate, s.london.thin, s.london.n) +
    sessRateRow('New York continues', 'of the days London expanded'+
                (s.ny.medContinuation!=null ? ' · median +'+s.ny.medContinuation+'% past the break' : ''),
                s.ny.continuationRate, s.ny.thin, s.ny.n);

  const sweepLine = s.ny.n
    ? 'New York swept the opposite side of London\'s range first on '+s.ny.sweptRate+'% of expansion days'+
      (s.ny.continuationGivenSwept!=null && s.ny.continuationGivenNoSwept!=null
        ? ' — it continued '+s.ny.continuationGivenSwept+'% of the time after sweeping, versus '+
          s.ny.continuationGivenNoSwept+'% when it did not.'
        : '.')
    : '';
  sweep.textContent = sweepLine;

  if(note) note.textContent = 'Dimmed rows have fewer than 30 days behind them. Break direction is decided by the '+
    'first London bar to trade beyond Asia\'s range, not by where London closed. This measures only the '+
    'history currently loaded for this coin, ignores fees and slippage, and past behaviour is not a promise '+
    'about tomorrow — read it as a lean, not proof.';
}

function renderSessions(){
  $('sesssub').textContent = symbolOf(active).sym+' — read on the 1H tape, UTC session boundaries.';
  renderSessionsLive();
  renderSessionsStats();
}

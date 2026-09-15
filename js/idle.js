/* idle.js — What the app does when you stop looking at it.

   Two states, and they are not the same thing. After five idle minutes the
   screen fades to the wordmark and breathes: that is a screensaver, it answers
   nothing, and any key or movement dismisses it. Press the wordmark instead and
   it opens into panel mode — a deliberately sparse read of whatever coin is
   open, sized to be legible from across a room and left running on a spare
   screen.

   Both are overlays. Neither touches the app underneath, which goes on polling,
   scanning and firing alerts exactly as before — this only changes what is
   drawn on top.

   part of Odysseus */

const IDLE_AFTER = 5 * 60 * 1000;    // five minutes, as asked
const IDLE_TICK  = 1000;             // the panel's own refresh; the app's data loop is unchanged

let idleTimer = 0, idleShown = false, panelOn = false, panelTimer = 0;

/*  Module-level flags are not readable from outside a classic script once
    copied, so the state is exposed through one accessor rather than three
    globals — which also gives a single place to look when asking why the
    screensaver did or did not appear.                                       */
function idleState(){ return {idleShown, panelOn, msUntilIdle: IDLE_AFTER}; }

/*  A person reading the panel is not idle, they are reading. So the idle timer
    stops entirely while the panel is open rather than firing underneath it.  */
function idleReset(){
  clearTimeout(idleTimer);
  if(idleShown) idleHide();
  if(!panelOn) idleTimer = setTimeout(idleShow, IDLE_AFTER);
}

function idleShow(){
  if(panelOn || idleShown) return;
  idleShown = true;
  const el = $('idle');
  if(!el) return;
  el.hidden = false;
  // one frame later, so the transition has a start state to move from
  requestAnimationFrame(()=> el.classList.add('on'));
}

function idleHide(){
  idleShown = false;
  const el = $('idle');
  if(!el) return;
  el.classList.remove('on');
  /*  Kept in the DOM through the fade rather than hidden immediately, or the
      overlay would vanish instead of dissolving.                            */
  setTimeout(()=>{ if(!idleShown) el.hidden = true; }, 420);
}

/* ---------- panel mode ---------- */

function panelOpen(){
  idleHide();
  clearTimeout(idleTimer);
  panelOn = true;
  const el = $('panel');
  if(!el) return;
  el.hidden = false;
  requestAnimationFrame(()=> el.classList.add('on'));
  panelPaint();
  clearInterval(panelTimer);
  panelTimer = setInterval(panelPaint, IDLE_TICK);
}

function panelClose(){
  panelOn = false;
  clearInterval(panelTimer);
  const el = $('panel');
  if(el){
    el.classList.remove('on');
    setTimeout(()=>{ if(!panelOn) el.hidden = true; }, 420);
  }
  idleReset();
}

function panelToggle(){ panelOn ? panelClose() : panelOpen(); }

/*  Everything here is read from state the app has already computed. The panel
    derives nothing of its own — a second opinion rendered large would be a
    genuinely bad idea.                                                       */
function panelPaint(){
  const el = $('panel');
  if(!el || el.hidden) return;

  const sym = active, meta = symbolOf(sym);
  const daily = data[sym] && data[sym]['1D'];
  const last = daily && daily.length ? daily[daily.length-1] : null;
  const prev = daily && daily.length > 1 ? daily[daily.length-2] : null;

  $('pn-sym').textContent = (meta && meta.name) || sym;
  $('pn-quote').textContent = sym + (MARKET === 'linear' ? ' · perpetual' : ' · spot');
  $('pn-px').textContent = last ? fmtUsd(last.c) : '—';

  const chg = $('pn-chg');
  if(last && prev){
    const pct = (last.c - prev.c) / prev.c * 100;
    chg.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    chg.className = 'pnchg ' + (pct >= 0 ? 'up' : 'down');
  }else{ chg.textContent = '—'; chg.className = 'pnchg'; }

  // the composite, worded the same way the terminal words it
  const st = states[sym];
  const score = st ? bias(st, WEIGHTS) : null;
  const read = $('pn-read'), sc = $('pn-score');
  if(score == null){
    read.textContent = 'Waiting for candles';
    sc.textContent = ''; sc.className = 'pnscore';
  }else{
    const agreeing = TFS.filter(t=>{ const v = sideOf(st[t.key]); return score >= 0 ? v > 0 : v < 0; }).length;
    read.textContent = Math.abs(score) <= 8
      ? 'Composite mixed — no frame majority'
      : 'Composite ' + (score > 0 ? 'long' : 'short') + ' — ' + agreeing + ' of 5 frames aligned';
    sc.textContent = (score > 0 ? '+' : '') + score;
    sc.className = 'pnscore ' + (score > 8 ? 'up' : score < -8 ? 'down' : '');
  }

  // the frame strip, weighted the way the terminal weights it
  const strip = $('pn-strip');
  strip.innerHTML = '';
  TFS.forEach(tf=>{
    const v = st ? sideOf(st[tf.key]) : 0;
    const col = v > 0.15 ? 'var(--up)' : v < -0.15 ? 'var(--down)' : 'var(--mute)';
    const seg = document.createElement('div');
    seg.className = 'pnseg';
    seg.style.flexGrow = String(tf.weight);
    seg.innerHTML = '<i style="background:'+col+';opacity:'+(0.12 + Math.min(1, Math.abs(v))*0.55)+'"></i>'+
                    '<b style="color:'+col+'">'+tf.key+'</b>';
    strip.appendChild(seg);
  });

  const now = new Date();
  $('pn-clock').textContent = now.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  // the same staleness the rail reports, so the panel never looks live when it is not
  const stale = lastOk && (Date.now() - lastOk) > 30000;
  $('pn-live').textContent = stale ? 'reconnecting' : 'live';
  $('pn-live').className = 'pnlive' + (stale ? ' stale' : '');
}

function idleInit(){
  /*  passive listeners: this only ever resets a timer, so it must never sit in
      the way of a scroll.                                                     */
  ['mousemove','mousedown','keydown','wheel','touchstart','scroll']
    .forEach(ev => addEventListener(ev, idleReset, {passive:true}));

  const idle = $('idle');
  if(idle) idle.onclick = panelOpen;

  const close = $('pn-close');
  if(close) close.onclick = panelClose;

  addEventListener('keydown', e=>{ if(e.key === 'Escape' && panelOn) panelClose(); });

  idleReset();
}

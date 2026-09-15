/* idle.js — What the app does when you stop looking at it.

   After a short idle the screen fades to the wordmark and breathes. That is the
   whole of it: it answers nothing, shows nothing, and any key, movement or
   scroll takes it away again.

   It is an overlay. The app underneath goes on polling, scanning and firing
   alerts exactly as before — this only changes what is drawn on top.

   part of Odysseus */

// how long without input before the mark appears. One constant, easy to move.
const IDLE_AFTER = 30 * 1000;

let idleTimer = 0, idleShown = false;

/*  Module-level flags are not readable from outside a classic script once
    copied, so the state is exposed through one accessor — which also gives a
    single place to look when asking why the mark did or did not appear.     */
function idleState(){ return {idleShown, msUntilIdle: IDLE_AFTER}; }

function idleReset(){
  clearTimeout(idleTimer);
  if(idleShown) idleHide();
  idleTimer = setTimeout(idleShow, IDLE_AFTER);
}

function idleShow(){
  if(idleShown) return;
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

function idleInit(){
  /*  passive listeners: this only ever resets a timer, so it must never sit in
      the way of a scroll.                                                     */
  ['mousemove','mousedown','keydown','wheel','touchstart','scroll']
    .forEach(ev => addEventListener(ev, idleReset, {passive:true}));

  /*  The wordmark in the rail brings it up on demand, without waiting out the
      thirty seconds. It works because click lands after mousedown: the reset
      above fires first and schedules a fresh timer, then this shows the mark,
      so the two never fight over the same gesture.                           */
  const brand = document.querySelector('.brand');
  if(brand){
    brand.title = 'Show the mark';
    brand.setAttribute('role', 'button');
    brand.setAttribute('tabindex', '0');
    brand.onclick = idleShow;
    brand.addEventListener('keydown', e=>{
      if(e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      /*  Unlike the click route, this is a single event: without stopping it
          here it would go on to the window listener above, be read as activity,
          and hide the mark in the same tick it was asked for.                */
      e.stopPropagation();
      idleShow();
    });
  }

  idleReset();
}

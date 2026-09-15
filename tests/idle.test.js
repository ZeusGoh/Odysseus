/* idle.test.js — the idle screen's state machine. The drawing is verified in a
   browser; what is worth pinning here is when it is allowed to appear at all,
   because the one behaviour that would actually annoy someone is a screensaver
   fading in over the panel they are reading.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['cloud.js','indicators.js','market-data.js','state.js','idle.js']);
const {IDLE_AFTER, idleShow, idleHide, idleReset, panelOpen, panelClose, panelToggle,
       idleState} = app;
// module-level flags are snapshotted by the harness, so read them live
const shown = ()=> idleState().idleShown, panelUp = ()=> idleState().panelOn;

suite('the delay is the five minutes that was asked for');
check('IDLE_AFTER is five minutes in milliseconds', IDLE_AFTER, 5*60*1000);

suite('the screensaver never appears over the panel');
{
  idleHide(); panelClose();
  idleShow();
  check('it shows when nothing else is open', shown(), true);

  idleHide();
  check('and hides again', shown(), false);

  panelOpen();
  check('opening the panel marks it open', panelUp(), true);
  idleShow();
  check('the screensaver refuses to appear underneath it', shown(), false);

  panelClose();
  check('closing releases the guard', panelUp(), false);
  idleShow();
  check('and it can appear again', shown(), true);
  idleHide();
}

suite('activity dismisses it');
{
  idleShow();
  check('shown', shown(), true);
  idleReset();
  check('any input takes it away', shown(), false);
}

suite('panelToggle is a toggle');
{
  panelClose();
  panelToggle();
  check('opens when closed', panelUp(), true);
  panelToggle();
  check('closes when open', panelUp(), false);
}

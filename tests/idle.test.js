/* idle.test.js — the idle screen's state machine. The drawing is verified in a
   browser; what is worth pinning here is when it appears and what takes it away.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['cloud.js','indicators.js','market-data.js','state.js','idle.js']);
const {IDLE_AFTER, idleShow, idleHide, idleReset, idleState} = app;
// module-level flags are snapshotted by the harness, so read them live
const shown = ()=> idleState().idleShown;

suite('the mark appears quickly rather than after five minutes');
check('IDLE_AFTER is thirty seconds', IDLE_AFTER, 30*1000);
check('and the accessor reports the same figure', idleState().msUntilIdle, IDLE_AFTER);

suite('showing and hiding');
{
  idleHide();
  check('hidden to start with', shown(), false);
  idleShow();
  check('shows', shown(), true);
  idleShow();
  check('showing twice is not an error and changes nothing', shown(), true);
  idleHide();
  check('hides', shown(), false);
}

suite('activity dismisses it');
{
  idleShow();
  check('shown', shown(), true);
  idleReset();
  check('any input takes it away', shown(), false);
}

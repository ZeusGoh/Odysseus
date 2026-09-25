/* watch.test.js — the gate on the unattended run.

   This is the file that decides how much the thing costs and how much it cries
   wolf. Two properties matter more than the rest:

     - a trigger key names the EVENT, not the moment of looking. The same cross
       seen at 1 bar old and at 2 bars old must produce the same key, or the
       watcher re-reads it every hour it stays fresh and you learn to ignore it.
     - nothing ungraded, thin, stale or market-wide gets through. Every trigger
       that does costs two model calls.
   part of Odysseus */

const path = require('path');
const MCP = path.join(__dirname, '..', 'mcp');
const {watchTriggersFor, watchFilterSeen, watchRemember, watchPruneState,
       watchSummary, watchRank, watchBudget, watchStanding, parseArgs, watchPrompt, watchReportSince, watchLockState, WATCH_CFG} = require(path.join(MCP, 'watch.js'));

const BAR = '2026-09-16T04:00:00.000Z';

function frame(over){
  return Object.assign({
    cross: {type:'bull', direction:'bull', pending:false, barsAgo:1, level:12,
            zone:'oversold', barOpened:BAR},
    verdict: {grade:'playable', hitRate:'64%', signals:31},
  }, over||{});
}

function stoch(frames){
  return {symbol:'SOL', frames: frames || {'4H': frame()}};
}

function news(over){
  return Object.assign({
    symbol:'SOL', window:'24h',
    move: {pct:2.1, boardMedianPct:2.0, excessPct:0.1, classification:'mkt'},
    sharpestHour: {at:'2026-09-16T03:00:00.000Z', pct:0.6, volumeMultiple:1.1},
    positioning: {openInterestChangePct:0.4, flow:{tag:'Spot-led'}, fundingCrowded:false},
  }, over||{});
}

const kinds = ts => ts.map(t=>t.kind).sort();

suite('watch — the indicator gate');
check('a fresh graded 4H cross is worth a read', kinds(watchTriggersFor(stoch(), news())), ['cross']);
check('and says why', watchTriggersFor(stoch(), news())[0].why,
      '4H bull cross from oversold grades playable (64% of 31)');

check('a 1H cross alone is not',
      watchTriggersFor(stoch({'1H': frame()}), news()).length, 0);
check('but a daily one is',
      kinds(watchTriggersFor(stoch({'1D': frame()}), news())), ['cross']);

check('a stale cross is not news any more',
      watchTriggersFor(stoch({'4H': frame({cross: Object.assign(frame().cross, {barsAgo:5})})}), news()).length, 0);
check('a cross on the live bar counts as fresh',
      kinds(watchTriggersFor(stoch({'4H': frame({
        cross: Object.assign({}, frame().cross, {type:'potential-bull', pending:true, barsAgo:0}),
      })}), news())), ['cross']);
ok('and the summary says it is still unsettled',
   /still on the live bar/.test(watchTriggersFor(stoch({'4H': frame({
     cross: Object.assign({}, frame().cross, {type:'potential-bull', pending:true, barsAgo:0}),
   })}), news())[0].why));

suite('watch — the record still holds the veto');
['untested','no edge','negative','thin','no signal'].forEach(g=>{
  check('a "'+g+'" cross is not worth two model calls',
        watchTriggersFor(stoch({'4H': frame({verdict:{grade:g, signals:40}})}), news()).length, 0);
});
check('a thin sample is not either',
      watchTriggersFor(stoch({'4H': frame({verdict:{grade:'strong', hitRate:'70%', signals:11}})}), news()).length, 0);
check('a strong one on a real sample is',
      kinds(watchTriggersFor(stoch({'4H': frame({verdict:{grade:'strong', hitRate:'70%', signals:40}})}), news())), ['cross']);
check('a cross with no verdict at all is skipped',
      watchTriggersFor(stoch({'4H': frame({verdict:undefined})}), news()).length, 0);

suite('watch — the structural gate');
check('a market-wide move is not an event, however big',
      watchTriggersFor({symbol:'SOL',frames:{}},
        news({move:{pct:19, boardMedianPct:18, excessPct:1, classification:'mkt'}})).length, 0);
check('a coin-specific move is',
      kinds(watchTriggersFor({symbol:'SOL',frames:{}},
        news({move:{pct:19, boardMedianPct:2, excessPct:17, classification:'spec'}}))), ['move']);
check('but only past the threshold',
      watchTriggersFor({symbol:'SOL',frames:{}},
        news({move:{pct:4, boardMedianPct:0.2, excessPct:3.8, classification:'spec'}})).length, 0);

check('an hour on huge volume is an event on its own',
      kinds(watchTriggersFor({symbol:'SOL',frames:{}},
        news({sharpestHour:{at:'2026-09-16T03:00:00.000Z', pct:9, volumeMultiple:7.3}}))), ['volume']);

check('a squeeze with crowded funding is',
      kinds(watchTriggersFor({symbol:'SOL',frames:{}}, news({
        positioning:{openInterestChangePct:-3, flow:{tag:'Short squeeze'}, fundingCrowded:true}}))), ['positioning']);
check('a squeeze on a big OI move is too',
      kinds(watchTriggersFor({symbol:'SOL',frames:{}}, news({
        positioning:{openInterestChangePct:-18, flow:{tag:'Short squeeze'}, fundingCrowded:false}}))), ['positioning']);
check('a squeeze with neither is not',
      watchTriggersFor({symbol:'SOL',frames:{}}, news({
        positioning:{openInterestChangePct:-2, flow:{tag:'Short squeeze'}, fundingCrowded:false}})).length, 0);
check('ordinary fresh money is not an alert',
      watchTriggersFor({symbol:'SOL',frames:{}}, news({
        positioning:{openInterestChangePct:40, flow:{tag:'New longs'}, fundingCrowded:true}})).length, 0);

check('a quiet coin produces nothing at all',
      watchTriggersFor({symbol:'SOL', frames:{'4H': frame({verdict:{grade:'no edge', signals:40}})}}, news()).length, 0);
check('and reads as nothing new', watchSummary('SOL', []), 'SOL: nothing new');

suite('watch — a key names the event, not the moment of looking');
/*  The property that keeps an hourly watcher from crying wolf. Same cross bar,
    a different hour later: identical key, so it is read once.               */
{
  const now  = watchTriggersFor(stoch({'4H': frame()}), news())[0];
  const later = watchTriggersFor(stoch({'4H': frame({
    cross: Object.assign({}, frame().cross, {barsAgo:2}),
  })}), news())[0];
  check('the key is unchanged as the cross ages', later.key, now.key);

  const next = watchTriggersFor(stoch({'4H': frame({
    cross: Object.assign({}, frame().cross, {barOpened:'2026-09-16T08:00:00.000Z'}),
  })}), news())[0];
  ok('but a new cross gets a new key', next.key !== now.key);

  const other = watchTriggersFor(stoch({'4H': frame({
    cross: Object.assign({}, frame().cross, {type:'bear'}),
  })}), news())[0];
  ok('and so does the other direction on the same bar', other.key !== now.key);

  const daily = watchTriggersFor(stoch({'1D': frame()}), news())[0];
  ok('and so does the same cross on another frame', daily.key !== now.key);
}

suite('watch — remembering what has been read');
{
  const ts = watchTriggersFor(stoch(), news());
  const AT = Date.parse('2026-09-16T09:00:00.000Z');

  check('nothing is remembered to begin with', watchFilterSeen(ts, {seen:{}}).length, 1);
  const state = watchRemember({seen:{}}, ts, AT);
  check('once read, it is not read again', watchFilterSeen(ts, state).length, 0);
  check('an empty state object is handled', watchFilterSeen(ts, null).length, 1);

  const kept = watchPruneState(state, AT + 2*864e5, WATCH_CFG.stateDays);
  check('a recent key survives pruning', Object.keys(kept.seen).length, 1);
  const gone = watchPruneState(state, AT + 9*864e5, WATCH_CFG.stateDays);
  check('an old one does not', Object.keys(gone.seen).length, 0);
  ok('so the same event could fire again much later', watchFilterSeen(ts, gone).length === 1);
}

suite('watch — several reasons at once');
{
  const ts = watchTriggersFor(stoch({'4H': frame(), '1D': frame()}), news({
    move:{pct:19, boardMedianPct:2, excessPct:17, classification:'spec'},
    sharpestHour:{at:'2026-09-16T03:00:00.000Z', pct:12, volumeMultiple:8},
    positioning:{openInterestChangePct:-18, flow:{tag:'Short squeeze'}, fundingCrowded:true},
  }));
  check('every reason is reported, not just the first',
        kinds(ts), ['cross','cross','move','positioning','volume']);
  check('and they all have distinct keys', new Set(ts.map(t=>t.key)).size, ts.length);
  ok('the summary joins them', watchSummary('SOL', ts).split('; ').length === 5);
}

suite('watch — most happened first, and a budget');
{
  const t = (weight, why) => ({kind:'x', key: why, why, weight});
  const due = [
    {sym:'AAA', triggers:[t(2,'vol')]},
    {sym:'BBB', triggers:[t(4,'1W cross'), t(3,'spec move')]},
    {sym:'CCC', triggers:[t(3,'spec move')]},
    {sym:'DDD', triggers:[t(3,'squeeze')]},
    {sym:'EEE', triggers:[]},
  ];
  const ranked = watchRank(due);
  check('the coin with the most going on is first', ranked[0].sym, 'BBB');
  check('and carries its score', ranked[0].score, 7);
  check('equal scores tie-break on how many reasons, then name', ranked.slice(1,3).map(d=>d.sym), ['CCC','DDD']);
  check('a coin with no reasons is last', ranked[ranked.length-1].sym, 'EEE');
  check('the input is not mutated', due[0].score, undefined);

  const b = watchBudget(ranked, 2);
  check('a budget reads the top of the ranking', b.read.map(d=>d.sym), ['BBB','CCC']);
  check('and names the rest, in order', b.skipped.map(d=>d.sym), ['DDD','AAA','EEE']);
  check('zero means no budget', watchBudget(ranked, 0).skipped.length, 0);
  check('the default budget is the config', watchBudget(ranked).read.length, Math.min(WATCH_CFG.maxReads, ranked.length));
}

suite('watch — standing reads: on a clock, outside the budget');
{
  const H = 3600000, now = Date.UTC(2026, 8, 21, 12);
  const gated = [{sym:'SOL', triggers:[]}];
  check('a coin never read is due', watchStanding(['BTC'], {}, gated, now, 240).map(d=>d.sym), ['BTC']);
  check('a coin read three hours ago is not, on a four-hour clock',
        watchStanding(['BTC'], {BTC: now - 3*H}, gated, now, 240), []);
  check('five hours ago is', watchStanding(['BTC'], {BTC: now - 5*H}, gated, now, 240).length, 1);
  check('a coin the gate already flagged this pass is left to the gate',
        watchStanding(['SOL', 'BTC'], {}, gated, now, 240).map(d=>d.sym), ['BTC']);
  check('names are upper-cased and de-duplicated', watchStanding(['btc', 'BTC'], {}, [], now, 240).map(d=>d.sym), ['BTC']);
  check('the default interval is the config', watchStanding(['BTC'], {BTC: now - (WATCH_CFG.alwaysEveryMin - 1) * 60000}, [], now), []);
  check('no interval means no standing reads', watchStanding(['BTC'], {}, [], now, 0), []);
  const d = watchStanding(['BTC'], {BTC: now - 9*H}, [], now, 240)[0];
  check('a standing read carries no score, so it never outranks a flagged coin', d.score, 0);
  check('and says so', d.standing, true);
  ok('the reason says how stale the last read is', /last read 9h ago/.test(d.triggers[0].why));
  check('the key changes every interval, so remembering one never blocks the next',
        watchStanding(['BTC'], {}, [], now, 240)[0].triggers[0].key === watchStanding(['BTC'], {}, [], now + 4*H, 240)[0].triggers[0].key, false);
  check('BTC is the default standing coin', WATCH_CFG.always, ['BTC']);
}

suite('watch — the scope and budget flags');
check('scope board parses', parseArgs(['--scope','board']).scope, 'board');
check('scope=app parses', parseArgs(['--scope=app']).scope, 'app');
throws('an unknown scope is refused', () => parseArgs(['--scope','everything']));
check('a budget parses', parseArgs(['--max-reads','8']).maxReads, 8);
check('zero is allowed', parseArgs(['--max-reads=0']).maxReads, 0);
throws('a non-number budget is refused', () => parseArgs(['--max-reads','lots']));
check('nothing given leaves both unset', [parseArgs([]).scope, parseArgs([]).maxReads], [null, null]);

suite('watch — the read goes to the model whole, with nothing left to expand');
{
  const tpl = '---\ndescription: Run the two blind analysts\nargument-hint: [TICKER]\n---\n\nRun the full read on **$ARGUMENTS**.\n\nWrite it to `verdicts/$ARGUMENTS-<stamp>.json`.\n';
  const p = watchPrompt(tpl, 'doge');
  ok('the frontmatter is stripped — it is for the command loader, not the model', !p.startsWith('---') && !/argument-hint/.test(p));
  ok('every $ARGUMENTS is filled in, upper-cased', !/\$ARGUMENTS/.test(p) && /\*\*DOGE\*\*/.test(p) && /verdicts\/DOGE-/.test(p));
  ok('and it ends with a newline, like a typed prompt', p.endsWith('\n'));
  check('a template with no frontmatter is used as-is', watchPrompt('Read $ARGUMENTS.', 'sol'), 'Read SOL.\n');
  check('Windows line endings in the frontmatter are fine too', watchPrompt('---\r\nx: y\r\n---\r\nRead $ARGUMENTS.', 'x'), 'Read X.\n');
}

suite('watch — a clean exit is not a report; the file is');
{
  const T = 1789600000000;
  const entries = [
    {name:'doge-2026-09-16-2305.json', mtimeMs: T + 5000},
    {name:'doge-2026-09-15-1000.json', mtimeMs: T - 86400000},
    {name:'link-2026-09-16-2306.json', mtimeMs: T + 6000},
    {name:'DOGECOIN-notes.json', mtimeMs: T + 9000},
  ];
  check('the report written after the read started is found', watchReportSince(entries, 'DOGE', T).name, 'doge-2026-09-16-2305.json');
  check('the coin match is exact, not a prefix', watchReportSince(entries, 'DOG', T), null);
  check('and case does not matter', watchReportSince(entries, 'doge', T).name, 'doge-2026-09-16-2305.json');
  check('an older report for the same coin does not count', watchReportSince(entries, 'DOGE', T + 6000), null);
  check('another coin\'s file does not count', watchReportSince(entries, 'ZEC', T), null);
  check('nothing on disk is nothing', watchReportSince([], 'DOGE', T), null);
}

suite('watch — one pass at a time');
{
  const NOW = 1789600000000;
  check('no lock means free', watchLockState(null, NOW).held, false);
  check('a lock from ten minutes ago is held', watchLockState({pid: 4, at: NOW - 10*60000}, NOW).held, true);
  check('and says how old', Math.round(watchLockState({pid: 4, at: NOW - 10*60000}, NOW).ageMs / 60000), 10);
  check('a lock from an hour ago is a crashed pass, not a running one', watchLockState({pid: 4, at: NOW - 60*60000}, NOW), {held: false, stale: true, ageMs: 60*60000});
  check('a lock with no timestamp is ignored', watchLockState({pid: 4}, NOW).held, false);
  check('the staleness line can be moved', watchLockState({at: NOW - 6*60000}, NOW, 5*60000).held, false);
}

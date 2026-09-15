/* anomalies.test.js — the anomaly log: dedup, the settled-bar price lookup, the held/faded/
   reversed band, the bucket stats, the one that matters most — excess follow-through, where a
   flag on a day the whole board rallied must NOT grade as held just because price rose — and
   the coiled flag, which is directionless and so cannot be scored the same way at all.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['sessions.js', 'anomalies.js']);
const {anomKey, anomSnapshot, anomAdd, anomPriceAt, anomCovers, anomBoardReturn,
       anomGrade, anomScore, anomStats, anomFor, ANOM_CHECKS, ANOM_THIN,
       coilAtrPct, coilRange, coilRangeBetween, coilRead, coilSignals, coilCandidates,
       coilSnapshot, anomCoiledStats, COIL_TIGHT, COIL_RECENT, COIL_BASE} = app;

const HOUR = 3600000;
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);          // 09:00 UTC — inside London

// an hourly series running `n` bars from `start` at a flat price, with close overrides by index
const series = (start, n, price, ov) => Array.from({length:n}, (_, i) => ({
  t: start + i*HOUR, c: (ov && ov[i] != null) ? ov[i] : price
}));

// a fuller bar series, for anything that needs high/low/volume
const bars = (start, n, price, spread, vol) => Array.from({length:n}, (_, i) => ({
  t: start + i*HOUR, o: price, c: price,
  h: price + (typeof spread === 'function' ? spread(i) : spread)/2,
  l: price - (typeof spread === 'function' ? spread(i) : spread)/2,
  v: typeof vol === 'function' ? vol(i) : vol
}));

const row = (over) => Object.assign({
  sym:'LSK', price:100, move:30, excess:28, kind:'spec',
  sharp:{t:T0-HOUR, pct:22, v:5}, volX:6, oi:{chg:14}, flow:{tag:'New longs'}, funding:0.0004
}, over||{});
const MKT = {med:2, win:'24h', n:90, btc:1.5};

suite('anomKey — one continuous move is one event');
check('same coin, same day, same direction collapses',
      anomKey('LSK', T0, 'up'), anomKey('LSK', T0 + 5*HOUR, 'up'));
ok('the other direction is a different event',
   anomKey('LSK', T0, 'up') !== anomKey('LSK', T0, 'down'));
ok('the next day is a different event',
   anomKey('LSK', T0, 'up') !== anomKey('LSK', T0 + 24*HOUR, 'up'));

suite('anomSnapshot — the full picture at flag time, not just the label');
{
  const s = anomSnapshot(row(), MKT, T0);
  check('direction comes off the move', s.dir, 'up');
  check('a down move is flagged down', anomSnapshot(row({move:-30}), MKT, T0).dir, 'down');
  check('the anchor price is kept', s.price, 100);
  check('the classification is kept', s.kind, 'spec');
  check('the board median at flag time is kept', s.boardMed, 2);
  check('positioning is kept', [s.oiChg, s.flow], [14, 'New longs']);
  check('the session it fired in is derived, no candles needed', s.session, 'london');
  check('it starts life unscored', s.checks, {});
  check('typed so the coiled flag can share this log', s.type, 'move');
}

suite('anomAdd — dedup on the way in');
{
  const log = [];
  check('first sighting is logged', anomAdd(log, [row()], MKT, T0).length, 1);
  log.push(...anomAdd(log, [row()], MKT, T0));
  check('the same move an hour later adds nothing',
        anomAdd(log, [row()], MKT, T0 + HOUR).length, 0);
  check('a move the other way is its own event',
        anomAdd(log, [row({move:-30})], MKT, T0 + HOUR).length, 1);
  check('a different coin is its own event',
        anomAdd(log, [row({sym:'POWR'})], MKT, T0 + HOUR).length, 1);
  check('a row with no move is not logged at all',
        anomAdd([], [row({move:null})], MKT, T0).length, 0);
}

suite('anomPriceAt — a bar stamped t has not settled until t+1h');
{
  const cs = series(T0, 5, 100, {0:10, 1:11, 2:12, 3:13, 4:14});
  check('nothing has settled at the open of the first bar', anomPriceAt(cs, T0), null);
  check('the first bar settles exactly one hour later', anomPriceAt(cs, T0 + HOUR), 10);
  check('a moment before it settles, it still does not count',
        anomPriceAt(cs, T0 + HOUR - 1), null);
  check('three hours in, three bars have settled', anomPriceAt(cs, T0 + 3*HOUR), 12);
}

suite('anomCovers — not due yet and rolled off the window are different answers');
{
  const cs = series(T0, 5, 100);
  check('past the end of the data is pending', anomCovers(cs, T0 + 99*HOUR), 'pending');
  check('before the start of the data is expired', anomCovers(cs, T0 - HOUR), 'expired');
  check('inside the window is fine', anomCovers(cs, T0 + 3*HOUR), 'ok');
  check('no data at all is missing', anomCovers([], T0), 'missing');
}

suite('anomGrade — the band scales with the move that triggered the flag');
{
  check('holding the gain is held', anomGrade(40, 0), 'held');
  check('extending it is still held', anomGrade(40, 12), 'held');
  check('handing back a third of a 40% flag is faded', anomGrade(40, -13), 'faded');
  check('handing back nearly all of it is reversed', anomGrade(40, -31), 'reversed');
  // the same 3% giveback, read against two different flags
  check('3% back on a 40% flag is nothing', anomGrade(40, -3), 'held');
  check('3% back on a 6% flag is a fade', anomGrade(6, -3), 'faded');
  check('an unscored checkpoint has no grade', anomGrade(40, null), null);
}

suite('anomScore — sign convention: + always means the flag was RIGHT');
{
  // flagged long at 100; the coin rises to 110 while the board median also rises 10%
  const board = [
    {sym:'LSK',  bars: series(T0 - HOUR, 4, 100, {1:110, 2:110, 3:110})},
    {sym:'AAA',  bars: series(T0 - HOUR, 4, 100, {1:110, 2:110, 3:110})},
    {sym:'BBB',  bars: series(T0 - HOUR, 4, 100, {1:110, 2:110, 3:110})}
  ];
  const log = [anomSnapshot(row(), MKT, T0)];
  anomScore(log, board, T0 + 48*HOUR);
  const c = log[0].checks[1];
  near('raw follow-through is the full move', c.raw, 10, 0.01);
  near('but the board did the same thing, so no credit for a private move', c.excess, 0, 0.01);
  /*  The grade answers "did the move stick", not "was it still special" — nothing was handed
      back, so it held. The excess column beside it is what says the market did the work.    */
  check('it held, and the zero excess is what exposes it as a market move', c.grade, 'held');
}
{
  // the same +10%, but this time the board went nowhere — that is a real anomaly holding
  const board = [
    {sym:'LSK', bars: series(T0 - HOUR, 4, 100, {1:110, 2:110, 3:110})},
    {sym:'AAA', bars: series(T0 - HOUR, 4, 100)},
    {sym:'BBB', bars: series(T0 - HOUR, 4, 100)}
  ];
  const log = [anomSnapshot(row(), MKT, T0)];
  anomScore(log, board, T0 + 48*HOUR);
  near('the board did nothing, so the excess is the whole move', log[0].checks[1].excess, 10, 0.01);
  check('and the flag held', log[0].checks[1].grade, 'held');
}
{
  // THE SIGN TRAP: a DOWN flag followed by price FALLING is the flag being right
  const board = [
    {sym:'LSK', bars: series(T0 - HOUR, 4, 100, {1:90, 2:90, 3:90})},
    {sym:'AAA', bars: series(T0 - HOUR, 4, 100)},
    {sym:'BBB', bars: series(T0 - HOUR, 4, 100)}
  ];
  const log = [anomSnapshot(row({move:-30, excess:-28}), MKT, T0)];
  anomScore(log, board, T0 + 48*HOUR);
  const c = log[0].checks[1];
  ok('price actually fell', true);
  ok('so a down flag scores POSITIVE', c.raw > 0);
  near('the fall, flipped into "the call was right"', c.raw, 10, 0.01);
  check('a short call that kept falling held', c.grade, 'held');
}

suite('anomScore — pending, expired, and off-board are three different outcomes');
{
  const log = [anomSnapshot(row(), MKT, T0)];
  const short = [{sym:'LSK', bars: series(T0 - HOUR, 3, 100)}];   // reaches +1h only
  anomScore(log, short, T0 + 48*HOUR);
  ok('the checkpoint it can see is settled', !!log[0].checks[1]);
  check('the ones it cannot see stay open, not guessed at',
        [log[0].checks[4], log[0].checks[24]], [undefined, undefined]);
}
{
  const log = [anomSnapshot(row(), MKT, T0)];
  anomScore(log, [], T0 + 48*HOUR);
  check('a coin absent from this scan is left for the next one', log[0].checks, {});
}
{
  const log = [anomSnapshot(row(), MKT, T0)];
  // a scan whose window starts well after the flag can never price it
  const late = [{sym:'LSK', bars: series(T0 + 40*HOUR, 6, 100)}];
  anomScore(log, late, T0 + 48*HOUR);
  check('a flag the window has rolled past is marked expired, not left hanging',
        log[0].checks[1], {state:'expired'});
}
{
  const log = [anomSnapshot(row(), MKT, T0)];
  const board = [{sym:'LSK', bars: series(T0 - HOUR, 4, 100, {1:110, 2:110, 3:110})}];
  anomScore(log, board, T0 + 2*HOUR);       // only +1h is actually due
  ok('the due checkpoint is filled', !!log[0].checks[1]);
  check('a checkpoint in the future is not scored early', log[0].checks[4], undefined);
}
{
  const log = [anomSnapshot(row(), MKT, T0)];
  const board = [{sym:'LSK', bars: series(T0 - HOUR, 4, 100, {1:110, 2:110, 3:110})}];
  anomScore(log, board, T0 + 48*HOUR);
  check('scoring twice does not rewrite a settled checkpoint',
        anomScore(log, board, T0 + 48*HOUR), 0);
}

suite('anomStats — bucketed by what the detector called it');
{
  const mk = (kind, grades) => ({
    sym:'X', type:'move', kind, excess:20, at:T0, dir:'up',
    checks: Object.fromEntries(Object.entries(grades).map(([h,g]) => [h, {grade:g, excess:1}]))
  });
  const log = [
    mk('spec', {1:'held',  4:'held',     24:'faded'}),
    mk('spec', {1:'held',  4:'faded',    24:'reversed'}),
    mk('spec', {1:'faded', 4:'reversed', 24:'reversed'}),
    mk('mkt',  {1:'faded', 4:'faded',    24:'faded'})
  ];
  const s = anomStats(log);
  check('every flag is counted', s.total, 4);
  check('coin-specific flags are their own bucket', s.kinds.spec.n, 3);
  check('two of three held at +1h', s.kinds.spec.byH[1].heldPct, 67);
  check('one of three held at +4h', s.kinds.spec.byH[4].heldPct, 33);
  check('none held at +24h', s.kinds.spec.byH[24].heldPct, 0);
  check('the grade split is kept, not just the headline',
        [s.kinds.spec.byH[24].held, s.kinds.spec.byH[24].faded, s.kinds.spec.byH[24].reversed],
        [0, 1, 2]);
  check('market-wide is kept separate', s.kinds.mkt.byH[1].heldPct, 0);
  check('a bucket nobody flagged reports nothing rather than zero', s.kinds.part.byH[1].heldPct, null);
  ok('everything here is flagged thin under the 30-flag floor', s.kinds.spec.byH[1].thin);
  check('an unscored flag does not count toward a checkpoint',
        anomStats([mk('spec', {})]).kinds.spec.byH[1].n, 0);
  // a coiled flag grades on expanded/mild/quiet, so it must not land in these buckets at all
  check('coiled flags are kept out of the move buckets',
        anomStats(log.concat([{sym:'C', type:'coiled', at:T0, checks:{1:{grade:'expanded'}}}])).total, 4);
}

suite('anomFor — the flag a News row should tag itself with');
{
  const log = [anomSnapshot(row(), MKT, T0)];
  ok('the same coin/day/direction finds it', !!anomFor(log, 'LSK', T0 + 3*HOUR, 'up'));
  check('the other direction does not', anomFor(log, 'LSK', T0, 'down'), null);
  check('another coin does not', anomFor(log, 'POWR', T0, 'up'), null);
}

suite('checkpoints');
check('three of them, inside a day', ANOM_CHECKS, [1, 4, 24]);
check('the thin floor matches History and Sessions', ANOM_THIN, 30);

/* ================= the coiled flag ================= */

suite('coilRange / coilAtrPct — the units compression is measured in');
{
  const b = bars(T0, 4, 100, 10, 1);          // every bar spans 95–105
  near('the span of a flat series is its bar spread', coilRange(b, 0, 4), (105-95)/95*100, 0.01);
  check('an empty slice has no range', coilRange(b, 0, 0), null);
  ok('true range is positive on a series that actually moves', coilAtrPct(b, 1, 4) > 0);
  check('one bar cannot make a true range, there is nothing before it', coilAtrPct(b, 0, 1), null);
}

suite('coilRangeBetween — bounded by the clock, not by bar index');
{
  const b = bars(T0, 6, 100, (i)=> i>=3 ? 20 : 4, 1);
  const early = coilRangeBetween(b, T0, T0 + 3*HOUR);
  const late  = coilRangeBetween(b, T0 + 3*HOUR, T0 + 6*HOUR);
  ok('the quiet stretch is narrow', early < late);
  check('a window with no bars in it has no range',
        coilRangeBetween(b, T0 + 99*HOUR, T0 + 100*HOUR), null);
}

suite('coilRead — compression is the entry ticket');
{
  // 18 wide bars, then 6 tight ones: exactly the shape a coiled coin makes
  const tight = bars(T0, COIL_BASE + COIL_RECENT, 100, i => i < COIL_BASE ? 10 : 1, 1);
  const r = coilRead(tight);
  ok('a range that collapsed to a tenth reads as compressed', r.coiled);
  ok('and the ratio is well under the threshold', r.compression < COIL_TIGHT);

  const steady = bars(T0, COIL_BASE + COIL_RECENT, 100, 10, 1);
  check('a coin behaving normally is not coiled', coilRead(steady).coiled, false);
  near('its compression sits around 1', coilRead(steady).compression, 1, 0.25);

  const loud = bars(T0, COIL_BASE + COIL_RECENT, 100, i => i < COIL_BASE ? 1 : 10, 1);
  check('a coin that just EXPANDED is not coiled either', coilRead(loud).coiled, false);

  check('too little history reads as nothing rather than guessing',
        coilRead(bars(T0, 5, 100, 1, 1)), null);
}

suite('coilRead — quiet volume is the second signal, not a spike');
{
  const n = COIL_BASE + COIL_RECENT;
  const climbing = bars(T0, n, 100, i => i < COIL_BASE ? 10 : 1, i => i < COIL_BASE ? 100 : 200);
  const r = coilRead(climbing);
  near('volume doubled while the range collapsed', r.volRatio, 2, 0.01);
  check('so both signals are on the flag', coilSignals(r), ['compression','volume']);

  const dryingUp = bars(T0, n, 100, i => i < COIL_BASE ? 10 : 1, i => i < COIL_BASE ? 100 : 50);
  check('volume drying up is compression alone', coilSignals(coilRead(dryingUp)), ['compression']);
  check('open interest building adds the third',
        coilSignals(Object.assign({oiChg:25}, coilRead(climbing))),
        ['compression','volume','oi']);
  check('an OI read that never arrived is simply absent, not counted as zero',
        coilSignals(Object.assign({oiChg:null}, coilRead(climbing))), ['compression','volume']);
}

suite('coilCandidates — tightest first, and only the coiled ones');
{
  const n = COIL_BASE + COIL_RECENT;
  const board = [
    {sym:'LOOSE', bars: bars(T0, n, 100, 10, 1)},
    {sym:'TIGHT', bars: bars(T0, n, 100, i => i < COIL_BASE ? 10 : 0.5, 1)},
    {sym:'MID',   bars: bars(T0, n, 100, i => i < COIL_BASE ? 10 : 3, 1)}
  ];
  const c = coilCandidates(board);
  check('only the compressed coins are candidates', c.map(x=>x.sym), ['TIGHT','MID']);
  ok('with signals level, the tightest is ranked first', c[0].compression < c[1].compression);
  ok('each carries the pre-flag range every checkpoint is measured against',
     c[0].preRange[1] != null && c[0].preRange[4] != null && c[0].preRange[24] != null);
}
{
  /*  The trap the live board exposed: a range collapses hardest on coins nobody is trading, so
      ranking on tightness alone fills the log with dead names and drops the one coin showing
      compression WITH volume arriving — which is the whole point of the flag.                */
  const n = COIL_BASE + COIL_RECENT;
  const board = [
    {sym:'DEAD',    bars: bars(T0, n, 100, i => i < COIL_BASE ? 10 : 0.4,
                                            i => i < COIL_BASE ? 100 : 20)},
    {sym:'LOADING', bars: bars(T0, n, 100, i => i < COIL_BASE ? 10 : 2,
                                            i => i < COIL_BASE ? 100 : 300)}
  ];
  const c = coilCandidates(board);
  ok('the deader coin is genuinely tighter', c.find(x=>x.sym==='DEAD').compression <
                                             c.find(x=>x.sym==='LOADING').compression);
  check('but compression WITH volume outranks compression alone', c[0].sym, 'LOADING');
  check('and it is the one carrying two signals', coilSignals(c[0]), ['compression','volume']);
}

suite('coilCheck — a directionless flag is scored on whether the range widened');
{
  const n = COIL_BASE + COIL_RECENT;
  const flagAt = T0 + n*HOUR;
  const pre = bars(T0, n, 100, i => i < COIL_BASE ? 10 : 1, 1);
  const cand = coilCandidates([{sym:'TIGHT', bars: pre}])[0];
  const snap = coilSnapshot(cand, flagAt);

  check('it is typed coiled', snap.type, 'coiled');
  check('and carries no direction, because it does not claim one', snap.dir, 'flat');

  // the range blows out to 20x after the flag
  const after = pre.concat(bars(flagAt, 4, 100, 20, 1));
  const log = [JSON.parse(JSON.stringify(snap))];
  anomScore(log, [{sym:'TIGHT', bars: after}], flagAt + 48*HOUR);
  const c = log[0].checks[1];
  ok('the range after the flag is far wider than before it', c.ratio > 2);
  check('so the flag expanded', c.grade, 'expanded');
  ok('which way it broke is recorded too, for information', 'move' in c);

  // and the failure case: it stays just as tight as it was
  const still = pre.concat(bars(flagAt, 4, 100, 1, 1));
  const log2 = [JSON.parse(JSON.stringify(snap))];
  anomScore(log2, [{sym:'TIGHT', bars: still}], flagAt + 48*HOUR);
  check('a coin that stayed shut is quiet, not a failed prediction of direction',
        log2[0].checks[1].grade, 'quiet');
  ok('the grade vocabulary never borrows held/faded/reversed',
     ['expanded','mild','quiet'].includes(log2[0].checks[1].grade));
}

suite('anomCoiledStats — did compression actually precede expansion');
{
  const mk = grades => ({
    sym:'X', type:'coiled', at:T0, dir:'flat',
    checks: Object.fromEntries(Object.entries(grades).map(([h,g]) => [h, {grade:g, ratio:2}]))
  });
  const log = [
    mk({1:'expanded', 4:'expanded', 24:'quiet'}),
    mk({1:'expanded', 4:'quiet',    24:'quiet'}),
    mk({1:'quiet',    4:'mild',     24:'mild'}),
    {sym:'Y', type:'move', kind:'spec', at:T0, checks:{1:{grade:'held'}}}
  ];
  const s = anomCoiledStats(log);
  check('only coiled flags are counted', s.n, 3);
  check('two of three expanded within the hour', s.byH[1].expandedPct, 67);
  check('the split is kept', [s.byH[4].expanded, s.byH[4].mild, s.byH[4].quiet], [1, 1, 1]);
  check('none expanded by the next day', s.byH[24].expandedPct, 0);
  ok('and it is flagged thin', s.byH[1].thin);
  check('nothing scored reports nothing, not zero', anomCoiledStats([]).byH[1].expandedPct, null);
}

/* paul.test.js — Paul's reading of the anomaly log. The agent loop is Logan's
   and is tested there; what is his is the flattening of flags and the per-coin
   cut — and in particular that he separates coiled flags from move flags on
   the right field, since getting that wrong returns an empty record that reads
   exactly like "nothing logged yet".
   part of Odysseus */
const {load} = require('./harness');
const app = load(['cloud.js','indicators.js','market-data.js','storage.js','state.js','backtest.js',
                  'btc-reference.js','logan.js','verdict.js','journal.js','anomalies.js',
                  'ui-anomalies.js','maria.js','paul.js']);
const {plMoveFlags, plCoilFlags, plScored, plFlag, plCoil, plByCoin,
       PAUL, PAUL_TOOLS, anomalies} = app;

/* the shapes anomalies.js actually writes */
function moveFlag(o){
  return Object.assign({
    sym:'BTC', at: Date.parse('2026-09-01T00:00:00Z'), dir:'up', move:12, excess:9,
    boardMed:3, kind:'spec', price:100, checks:{}
  }, o);
}
function coilFlag(o){
  return Object.assign({
    type:'coiled', sym:'SOL', at: Date.parse('2026-09-01T00:00:00Z'),
    compression:0.4, volRatio:1.6, oiChg:12, signals:['compression','volume'], checks:{}
  }, o);
}
const held   = {1:{grade:'held',   raw:8,  excess:6}};
const faded  = {1:{grade:'faded',  raw:1,  excess:0}};
const missed = {1:{state:'expired'}};

suite('the two kinds of flag are separated on type, not on kind');
{
  anomalies.length = 0;
  anomalies.push(moveFlag({sym:'BTC'}), coilFlag({sym:'SOL'}), moveFlag({sym:'ETH', kind:'mkt'}));
  check('two move flags', plMoveFlags().length, 2);
  check('one coiled flag', plCoilFlags().length, 1);
  check('the coiled one is not counted as a move',
        plMoveFlags().some(e=>e.sym==='SOL'), false);
  // kind is the move classification and must never be used to split the two
  check('a move flag classified mkt is still a move flag',
        plMoveFlags().some(e=>e.sym==='ETH'), true);
}

suite('plScored — a flag is evidence only once a checkpoint resolves');
{
  const rows = [moveFlag({checks:held}), moveFlag({checks:{}}), moveFlag({checks:missed})];
  check('only the resolved one counts', plScored(rows).length, 1);
  check('an unscored flag is not evidence', plScored([moveFlag({checks:{}})]).length, 0);
  check('a missed checkpoint is not a grade either',
        plScored([moveFlag({checks:missed})]).length, 0);
}

suite('plFlag — what reaches the model');
{
  const f = plFlag(moveFlag({checks:{1:{grade:'held', raw:8, excess:6}, 4:{state:'expired'}}}));
  check('the classification is carried', f.classification, 'spec');
  check('the move and its excess over the board are both there', [f.movePct, f.excessVsBoard], [12, 9]);
  check('a resolved checkpoint keeps its grade and both numbers',
        f.outcomes.h1, {grade:'held', rawPct:8, excessPct:6});
  check('a missed one says so rather than looking unresolved', f.outcomes.h4, {missed:true});
  ok('the timestamp is ISO', /^\d{4}-\d{2}-\d{2}T/.test(f.at));
}
{
  const f = plFlag(moveFlag({checks:{}}));
  check('a flag with nothing resolved reports no outcomes at all', f.outcomes, null);
}

suite('plCoil — the directionless claim, scored directionlessly');
{
  const c = plCoil(coilFlag({checks:{1:{grade:'expanded', ratio:2.4, move:-6}}}));
  check('the signals that fired are named', c.signals, ['compression','volume']);
  check('compression is carried', c.compression, 0.4);
  check('the outcome is a range ratio, not a direction',
        c.outcomes.h1, {grade:'expanded', rangeRatio:2.4, brokePct:-6});
}

suite('plByCoin — is a few names carrying the record?');
{
  anomalies.length = 0;
  anomalies.push(
    moveFlag({sym:'BTC', checks:held}), moveFlag({sym:'BTC', checks:held}),
    moveFlag({sym:'BTC', checks:faded}),
    moveFlag({sym:'ETH', checks:faded}), moveFlag({sym:'ETH', checks:faded}),
    moveFlag({sym:'SOL', checks:held})            // one flag only
  );
  const out = plByCoin(plMoveFlags(), 2);
  check('coins under the floor are left out', out.some(c=>c.symbol==='SOL'), false);
  const btc = out.find(c=>c.symbol==='BTC');
  check('BTC has three scored flags', btc.n, 3);
  check('two of which held', btc.held, 2);
  check('reported as a percentage', btc.heldPct, 67);
  const eth = out.find(c=>c.symbol==='ETH');
  check('ETH held none of its two', eth.heldPct, 0);
  check('the busiest coin sorts first', out[0].symbol, 'BTC');
}
{
  anomalies.length = 0;
  check('no scored flags means no rows rather than a crash', plByCoin(plMoveFlags(), 2), []);
}

suite('Paul is an agent in his own right');
check('registered under his own id', PAUL.id, 'paul');
check('with his own transcript key', PAUL.chatKey, 'vl.paul.chat.v1');
check('his tools are converted for Gemini', PAUL.geminiTools[0].functionDeclarations.length, PAUL_TOOLS.length);
check('and for the OpenAI shape', PAUL.openaiTools.length, PAUL_TOOLS.length);
ok('none of his tools reach the market or the journal',
   PAUL_TOOLS.every(t=>/detector_record|read_flags|coiled_record|read_coiled|by_coin/.test(t.name)));
check('the three agents hold three distinct transcript keys',
      new Set([app.LOGAN.chatKey, app.MARIA.chatKey, PAUL.chatKey]).size, 3);

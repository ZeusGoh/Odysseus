/* maria.test.js — Maria's arithmetic over the journal. The agent loop itself
   is Logan's and is tested there; what is specific to her is how a trade
   history is cut up, and in particular the frame-agreement question that the
   old single-frame record could not answer at all.
   part of Odysseus */
const {load} = require('./harness');
const app = load(['cloud.js','indicators.js','market-data.js','storage.js','state.js','backtest.js',
                  'btc-reference.js','logan.js','verdict.js','journal.js','maria.js']);
const {mrAlignBand, mrFrameAgreement, mrZoneAgreement, mrTrade, MARIA_TOOLS, MARIA, MR_GROUPERS,
       jFramesAlignment} = app;

/* a closed trade, built the way jAdd would have left it */
function trade(o){
  return Object.assign({
    id:'t'+Math.random().toString(36).slice(2), symbol:'BTC', frame:'4H', direction:'long',
    entryPrice:100, invalidation:90, size:1, status:'closed',
    entryTime: Date.parse('2026-09-01T12:00:00Z'), exitTime: Date.parse('2026-09-02T12:00:00Z'),
    wave:'', notes:'', closeNote:'', verdict:null, frames:null, alignment:null
  }, o);
}
// exit 110 on a long entered at 100 with a 10-wide stop is +1R; exit 90 is -1R
const WIN  = o => trade(Object.assign({exitPrice:110}, o));
const LOSS = o => trade(Object.assign({exitPrice:90},  o));

function frames(spec){
  // spec: {'1M':'bull','1W':'bear',...} → the stored five-frame snapshot shape
  return Object.keys(spec).map(k=>({
    frame:k, weight:1, K:50, D:50, spread:0, zone:'middle',
    side:spec[k], signal:null, settled:null, barsAgo:null, barTime:0
  }));
}

suite('jFramesAlignment — how much of the board was with the trade');
{
  const all = frames({'1M':'bull','1W':'bull','1D':'bull','4H':'bull','1H':'bull'});
  check('every frame agreeing with a long is +1', jFramesAlignment(all, 'long'), 1);
  check('the same board is -1 for a short', jFramesAlignment(all, 'short'), -1);
  const split = frames({'1M':'bull','1W':'bull','1D':'bear','4H':'bear'});
  check('an even split is 0', jFramesAlignment(split, 'long'), 0);
  check('no frames means no alignment, not zero', jFramesAlignment(null, 'long'), null);
}
{
  // weight is what stops a 1H reading outvoting the weekly
  const heavy = [{frame:'1W', weight:5, side:'bear'}, {frame:'1H', weight:1, side:'bull'}];
  const a = jFramesAlignment(heavy, 'long');
  ok('a heavy frame against outweighs a light frame for', a < 0);
}

suite('mrAlignBand — the bands a finding can actually be stated in');
check('strongly with the board', mrAlignBand({alignment: 0.8}), 'with');
check('strongly against it', mrAlignBand({alignment:-0.8}), 'against');
check('near the middle is mixed', mrAlignBand({alignment: 0.1}), 'mixed');
check('a trade with no snapshot has no band', mrAlignBand({alignment:null}), null);

suite('mrFrameAgreement — the question the single traded frame could not answer');
{
  // every one of these is a long; the 1W is bearish on the losers and bullish
  // on the winners, which is exactly the habit Maria exists to surface
  const rows = [
    WIN ({frames: frames({'1W':'bull','4H':'bull'})}),
    WIN ({frames: frames({'1W':'bull','4H':'bull'})}),
    LOSS({frames: frames({'1W':'bear','4H':'bull'})}),
    LOSS({frames: frames({'1W':'bear','4H':'bull'})}),
    LOSS({frames: frames({'1W':'bear','4H':'bull'})})
  ];
  const out = mrFrameAgreement(rows);
  const wk = out.find(f=>f.frame === '1W');
  check('the weekly is reported on', !!wk, true);
  check('two trades had the weekly with them', wk.whenAgreed.n, 2);
  check('and they both won', wk.whenAgreed.winRate, 100);
  check('three had it against them', wk.whenAgainst.n, 3);
  check('and all three lost', wk.whenAgainst.winRate, 0);

  const h4 = out.find(f=>f.frame === '4H');
  check('the traded frame agreed every time, so it separates nothing', h4.whenAgreed.n, 5);
  check('with nothing on the other side', h4.whenAgainst, null);
}
check('no snapshots means no frame findings rather than an empty shape',
      mrFrameAgreement([WIN({}), LOSS({})]), []);

suite('mrZoneAgreement — frame-and-zone conditions at entry');
{
  const os = frames({'4H':'bull'}); os[0].zone = 'oversold';
  const ob = frames({'4H':'bull'}); ob[0].zone = 'overbought';
  const rows = [WIN({frames:os}), WIN({frames:os}), LOSS({frames:ob}), LOSS({frames:ob})];
  const out = mrZoneAgreement(rows);
  const good = out.find(c=>c.condition === '4H oversold');
  const bad  = out.find(c=>c.condition === '4H overbought');
  check('oversold entries are grouped', good.n, 2);
  check('and won', good.winRate, 100);
  check('overbought entries are grouped separately', bad.n, 2);
  check('and lost', bad.winRate, 0);
}
check('a condition seen only once is not reported as a pattern',
      mrZoneAgreement([WIN({frames: frames({'4H':'bull'})})]), []);

suite('mrTrade — what reaches the model');
{
  const t = mrTrade(WIN({notes:'chased it', wave:'wave 3', alignment:0.6,
                         frames: frames({'4H':'bull'})}));
  check('R is computed, not stored', t.R, 1);
  check('the note written at entry survives', t.notes, 'chased it');
  check('the wave survives', t.wave, 'wave 3');
  check('the band is derived for grouping', t.alignmentBand, 'with');
  check('the frame snapshot is passed through', t.frames.length, 1);
  ok('timestamps are ISO, not raw epoch numbers', /^\d{4}-\d{2}-\d{2}T/.test(t.enteredAt));
  check('how long it was held is stated in hours', t.heldHours, 24);
}

suite('Maria is wired as an agent in her own right');
check('she is registered under her own id', MARIA.id, 'maria');
check('with her own transcript key, separate from Logan\'s', MARIA.chatKey, 'vl.maria.chat.v1');
ok('her tools are converted for Gemini like any agent\'s', MARIA.geminiTools[0].functionDeclarations.length === MARIA_TOOLS.length);
ok('and for the OpenAI shape too', MARIA.openaiTools.length === MARIA_TOOLS.length);
ok('every tool she has is journal-facing, none reach the market',
   MARIA_TOOLS.every(t=>/performance|read_trades|group_outcomes|frame_agreement|zone_outcomes/.test(t.name)));
check('every grouping dimension the tool advertises is actually implemented',
      MARIA_TOOLS.find(t=>t.name==='group_outcomes').input_schema.properties.by.enum
        .filter(k=>!MR_GROUPERS[k]), []);

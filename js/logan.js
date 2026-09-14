/* logan.js — Logan — the in-app analyst. Tool schemas, the bounded tool loop, the API call,
   and the chat UI. Reads the app's own numbers; cannot trade and cannot send messages.
   part of Odysseus */

/* ---------- Logan ---------- */
const LG_KEY = 'vl.logan.v1';
/*  Opened straight off disk, the page has a null origin and the API's CORS
    check rejects it no matter how good the key is. Say so before they waste
    time blaming the key.                                                    */
const isFileOrigin = () => location.protocol === 'file:';
const FILE_HINT = 'You opened this file directly from disk, so the browser sends no origin and the API will refuse the call whatever key you use. Serve the folder instead: open a terminal where this file lives, run  python3 -m http.server 8000  then visit http://localhost:8000/ and click the file.';
let lgChat = [];                 // {role, content}
let lgBusy = false;

/*  Two backends, one agent. lgCfg keeps each provider's key/model under its
    own field so switching back and forth never clobbers the other one. Older
    saves only ever had {key, model} — that always meant Anthropic — so it is
    migrated forward once rather than treated as gone.                       */
const lgCfg = (()=>{
  let c;
  try{ c = JSON.parse(localStorage.getItem(LG_KEY)||'{}'); }catch(e){ c = {}; }
  if(c.key && !c.anthropicKey) c.anthropicKey = c.key;
  if(c.model && !c.anthropicModel) c.anthropicModel = c.model;
  if(!c.provider) c.provider = 'anthropic';
  return c;
})();

function lgSaveCfg(){
  return vlPut(LG_KEY, JSON.stringify(lgCfg));
}

function lgActiveKey(){ return lgCfg.provider === 'gemini' ? lgCfg.geminiKey : lgCfg.anthropicKey; }
function lgActiveModel(){
  return lgCfg.provider === 'gemini'
    ? (lgCfg.geminiModel || 'gemini-3.8-flash')
    : (lgCfg.anthropicModel || 'claude-sonnet-5');
}
function lgHasKey(){ return !!lgActiveKey(); }
function lgProviderLabel(){ return lgCfg.provider === 'gemini' ? 'Gemini' : 'Claude'; }
function lgProviderHost(){ return lgCfg.provider === 'gemini' ? 'generativelanguage.googleapis.com' : 'api.anthropic.com'; }

/* ---------- Logan's memory ----------
   The visible chat and the API-shaped transcript used to live only in memory,
   so every reload wiped them and Logan met you fresh each time. Both are kept
   on disk now, under their own key rather than inside lgCfg — the config is a
   handful of bytes read on every call, and a long transcript has no business
   riding along with it.

   Two things make this less trivial than it looks. The transcript grows without
   bound, so old exchanges are dropped off the front once it gets heavy; and the
   two providers shape their transcripts differently, so one built under Claude
   cannot be replayed to Gemini. The cut is always made at an exchange boundary,
   never mid-tool-loop, because a tool_result with no matching tool_use is a hard
   API error.                                                                  */
const LG_CHAT_KEY = 'vl.logan.chat.v1';
const LG_CHAT_MAX = 180000;      // ~180KB of transcript kept; older exchanges fall off the front

// an lgApi entry that opens a new exchange: a real user message, not a
// tool_result / functionResponse carrier (which also uses role 'user')
function lgIsUserTurn(m){
  if(!m || m.role !== 'user') return false;
  if(typeof m.content === 'string') return true;                              // Anthropic user text
  if(Array.isArray(m.parts)) return m.parts.some(p => typeof p.text === 'string');  // Gemini user text
  return false;
}

// drop the oldest complete exchange from both transcripts at once. Returns
// false when only one exchange is left, since half an exchange is unusable.
function lgDropOldestExchange(){
  const a0 = lgApi.findIndex(lgIsUserTurn);
  const a1 = lgApi.findIndex((m,i)=> i > a0 && lgIsUserTurn(m));
  const c0 = lgChat.findIndex(m => m.role === 'user');
  const c1 = lgChat.findIndex((m,i)=> i > c0 && m.role === 'user');
  if(a1 < 0 || c1 < 0) return false;
  lgApi  = lgApi.slice(a1);
  lgChat = lgChat.slice(c1);
  return true;
}

function lgSaveChat(){
  try{
    const pack = ()=> JSON.stringify({v:1, provider:lgCfg.provider, at:Date.now(),
                                      chat:lgChat, api:lgApi});
    let blob = pack();
    while(blob.length > LG_CHAT_MAX && lgDropOldestExchange()) blob = pack();
    return vlPut(LG_CHAT_KEY, blob);
  }catch(e){ return false; }
}

function lgLoadChat(){
  try{
    const raw = JSON.parse(localStorage.getItem(LG_CHAT_KEY) || 'null');
    if(!raw || !Array.isArray(raw.chat) || !Array.isArray(raw.api)) return;
    lgChat = raw.chat;
    /*  A transcript recorded under the other provider is kept on screen but not
        replayed — the wire formats do not interchange, and sending Claude's
        blocks to Gemini fails outright. Logan sees a fresh context; you still
        see what was said.                                                     */
    lgApi = (raw.provider === lgCfg.provider) ? raw.api : [];
  }catch(e){}
}

/*  Cleared by writing an empty transcript rather than deleting the key. A
    deleted key looks like "nothing to say" to the sync, which would let the
    other machine's copy flow back on the next pull and undo the clear.      */
function lgForgetChat(){
  lgChat = []; lgApi = [];
  lgSaveChat();
}

/*  Logan is handed the numbers the app has already computed. He is not asked to
    read a chart or recall prices — everything he cites comes from this object,
    which is why he can be held to "do not invent data".                      */
function loganContext(symArg){
  const sym = symArg || active, meta = symbolOf(sym);
  const daily = data[sym] && data[sym]['1D'];
  const last = daily && daily[daily.length-1];
  const prev = daily && daily[daily.length-2];

  const frames = TFS.map(tf=>{
    const st = states[sym] && states[sym][tf.key];
    const sd = stoch[sym] && stoch[sym][tf.key];
    const dv = divNow[sym] && divNow[sym][tf.key];
    const k = sd ? sd.k[sd.k.length-1] : null;
    const d = sd ? sd.d[sd.d.length-1] : null;
    return {
      frame: tf.key, weight: tf.weight,
      K: k==null?null:+k.toFixed(1), D: d==null?null:+d.toFixed(1),
      spread: (k==null||d==null)?null:+(k-d).toFixed(1),
      zone: k==null?null:zoneOf(k),
      signal: st ? st.type : null,
      settled: st ? !st.pending : null,
      barsSinceCross: st && st.barsAgo!=null ? st.barsAgo : null,
      crossLevel: st && st.level!=null ? +st.level.toFixed(1) : null,
      divergence: dv ? {direction:dv.dir, legs:dv.legs+1,
                        settled:!dv.pending, barsSince:dv.barsAgo} : null
    };
  });

  const wl = watch.map(code=>{
    const sc = states[code] ? bias(states[code], WEIGHTS) : null;
    return {symbol:code, composite:sc};
  });

  return {
    venue: MARKET==='linear' ? 'Bybit USDT perpetual' : 'Bybit spot',
    symbol: meta.sym, name: meta.name,
    price: last ? last.c : null,
    changeSincePrevDailyClose: (last&&prev) ? +(((last.c-prev.c)/prev.c)*100).toFixed(2) : null,
    composite: states[sym] ? bias(states[sym], WEIGHTS) : null,
    frames,
    watchlist: wl,
    generatedAt: new Date().toISOString()
  };
}

const LOGAN_SYSTEM = `You are Logan, the analyst built into ODYSSEUS, a stochastic terminal for crypto perpetuals.

HOW THE INDICATOR WORKS (this is the app's exact logic):
- Stochastic 5,3,3 on each of five frames: 1M, 1W, 1D, 4H, 1H.
- A cross is %K crossing %D. Direction alone decides bull or bear, at any level on the scale.
- "settled: true" means the cross printed on a bar that has closed and cannot be revised.
  "settled: false" means it is on the bar still forming and can unwind before close.
- Zones: oversold 0-20, middle 21-79, overbought 80-100. The zone grades the QUALITY of a
  cross, never its direction. A cross out of oversold is the strongest bullish case; a cross
  in the middle is continuation; a bullish cross in overbought is late and extended.
- Divergence is measured between adjacent swings, heights taken off %K only, and is void if
  %K cuts through the connecting line. "legs" counts the swings in the run.
- composite is a weighted score from -100 to +100. Frames are weighted 1M=5, 1W=4, 1D=3,
  4H=2, 1H=1, so the slow frames dominate.

YOU HAVE TOOLS. USE THEM.
- The context below is only the coin currently open. For anything else — a second coin, the
  backtest, a board sweep, what is moving, headlines — call the tool. Do not answer from
  memory and do not guess.
- read_coin before commenting on any coin you have not read this conversation.
- assess_trade is the tool for "is this a good trade". It returns a graded verdict with the hit rate,
  the sample size and what helped or hurt. Lead your answer with that verdict in your own words, then
  the evidence. Do not hedge it into mush — if the grade is "no edge" or "negative", say so directly.
- Never call something a good trade on a thin sample or a sub-50% hit rate, however well BTC and the
  200 line up. The record is the evidence; confluence only ever adds to a setup that already works.
- signal_history whenever the question is whether a setup is worth taking. Quote the sample
  size alongside the hit rate; a 4-signal bucket is an anecdote, not evidence.
- Returns in signal_history are direction-adjusted: + means the call was RIGHT, so on a bear
  setup a positive median means price FELL. Never report it as a rise.
- Percentages are not comparable across frames — a 4H move and a 1M move are different
  animals. Use the "beats an ordinary cross on this frame" multiple to compare setups.
- open_coin and watchlist change what the user sees. Use them when asked or when you have
  found something worth their attention, and say plainly what you changed.
- Prefer one good tool call over three speculative ones. scan_market is slow; do not reach
  for it when the user asked about one coin.

HOW TO ANSWER:
- Every number you cite must come from the context object or a tool result. Never invent or
  recall a price, level or date. If something is not there, say so plainly.
- Lead with the read, then the evidence. Be concise and concrete: a few short paragraphs.
- Weight the slow frames more heavily, and say clearly when frames disagree.
- Distinguish settled signals from unsettled ones every time it matters.
- Plain prose. No headers, no bullet lists unless comparing several coins. No emoji.
- You are describing what the indicator shows, not issuing instructions to trade. The user
  makes their own decisions and manages their own risk. Do not express false certainty about
  what price will do next, and do not suggest position sizes or leverage.`;

function lgPush(role, content, cls){
  lgChat.push({role, content});
  lgSaveChat();
  lgRender(cls);
}

function lgRender(cls){
  const log = $('lg-log');
  if(!lgChat.length){
    const keyed = lgHasKey();
    log.innerHTML = '<div class="lgempty"><b>Logan reads the live state of whatever you have open.</b>'+
      (keyed
        ? 'He is an agent, not just a chat box: he can read any coin, pull the backtest for a setup, '+
          'sweep the board, find what is moving and why, check headlines, switch the terminal and edit '+
          'your watchlist. You will see each step as he takes it. Running on '+lgProviderLabel()+'.'
        : 'With no API key connected he answers from the <b>built-in reader</b>: deterministic, offline '+
          'and free, walking the same numbers the panel shows. It states what they say but cannot hold '+
          'a conversation.<br><br>For actual reasoning at no cost, press <b>Copy briefing</b> and paste '+
          'it into a Claude chat — that uses the subscription you already have.')+
      '</div>';
    return;
  }
  log.innerHTML = '';
  lgChat.forEach((m,i)=>{
    if(m.role === 'tool'){
      const t = document.createElement('div');
      t.className = 'lgtool';
      t.textContent = m.content;
      log.appendChild(t);
      return;
    }
    const el = document.createElement('div');
    el.className = 'lgmsg' + (m.error?' err':'');
    el.innerHTML = '<div class="lgwho'+(m.role==='user'?' me':'')+'">'+
                   (m.role==='user'?'You':'LOGAN')+'</div>'+
                   '<div class="lgbody"></div>';
    el.querySelector('.lgbody').textContent = m.content;
    log.appendChild(el);
  });
  if(lgBusy){
    const el = document.createElement('div');
    el.className = 'lgmsg';
    el.innerHTML = '<div class="lgwho">LOGAN</div><div class="lgbody">'+
                   '<span class="lgdots"><i></i><i></i><i></i></span></div>';
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
}

/* ============================================================
   Logan, as an agent.

   Logan used to be handed a single snapshot of whichever coin was open and
   asked to comment on it. That made him a narrator: he could not look at a
   second coin, could not check the backtest, could not sweep the board, and
   could not act on anything he found. Tools change what he is — he can now
   fetch what he needs across any coin and drive the terminal.

   Deliberately NOT given a tool: arming alerts. That pushes messages out to
   Telegram, and an outbound message sent on a model's initiative is a
   different class of act from reading a chart. It stays a human click.
   ============================================================ */

const LG_MAX_TURNS = 6;     // a hard stop — a loop that never lands is worse than a wrong answer
let lgApi = [];             // API-shaped transcript, including tool blocks

const LG_TOOLS = [
  { name:'read_coin',
    description:'Read the full multi-timeframe stochastic state of any coin: %K/%D on all five frames, '+
      'the zone, which crosses have fired and whether they have settled, divergence runs, the 200 EMA '+
      'and the weighted composite. Loads the coin if it is not already in memory. Call this before '+
      'saying anything specific about a coin you have not already read.',
    input_schema:{type:'object', properties:{
      symbol:{type:'string', description:'Ticker such as BTC, SOL, HYPE'}}, required:['symbol']} },

  { name:'signal_history',
    description:'The backtest for a coin: how past stochastic crosses actually performed, split by frame, '+
      'direction and the zone the cross came from. Returns hit rate and median move at each horizon, the '+
      'sample size, and how far each setup beats an ordinary cross on its own frame. Use this whenever '+
      'the question is whether a setup is worth taking.',
    input_schema:{type:'object', properties:{
      symbol:{type:'string'},
      frame:{type:'string', enum:['1M','1W','1D','4H','1H'], description:'Optional: restrict to one frame'}},
      required:['symbol']} },

  { name:'scan_market',
    description:'Sweep the perpetual board for coins whose stochastic is turning right now, ranked by '+
      'setup quality. Slow — one request per coin per frame — so keep depth modest unless a full sweep '+
      'is asked for.',
    input_schema:{type:'object', properties:{
      frames:{type:'array', items:{type:'string', enum:['1M','1W','1D','4H','1H']}},
      side:{type:'string', enum:['both','bull','bear']},
      depth:{type:'integer', description:'How many coins deep by turnover. Default 60, max 200.'},
      limit:{type:'integer', description:'How many rows to return. Default 12.'}}} },

  { name:'find_movers',
    description:'Find coins that moved abnormally over a window, each with whether the move was the whole '+
      'market or specific to that coin, the sharpest single hour, and what open interest and funding did. '+
      'This is the tool for "what is moving, and why".',
    input_schema:{type:'object', properties:{
      window:{type:'string', enum:['1h','4h','24h']},
      min_move:{type:'number', description:'Minimum absolute % move. Default 5.'},
      limit:{type:'integer', description:'Default 10.'}}} },

  { name:'coin_news',
    description:'Headlines that actually name a given coin, from the major desks plus the Bybit and '+
      'Binance listing feeds, ranked by whether they broke before or after the move.',
    input_schema:{type:'object', properties:{
      symbol:{type:'string'}}, required:['symbol']} },

  { name:'assess_trade',
    description:'Grade a live cross as a trade: its historical hit rate and median move, how far it beats '+
      'an ordinary cross on that frame, whether divergence backing has actually helped it before, BTC and '+
      '200 EMA agreement, and a verdict of strong / playable / thin / no edge / negative / untested. This '+
      'is the tool for "is this worth taking". Omit the frame to get the best live setup on the coin.',
    input_schema:{type:'object', properties:{
      symbol:{type:'string'},
      frame:{type:'string', enum:['1M','1W','1D','4H','1H'],
             description:'Optional: grade this frame. Omit for the best live setup.'}},
      required:['symbol']} },

  { name:'open_coin',
    description:'Switch the terminal to a coin so the user is looking at it. Use when they ask to see '+
      'something, or once you have found something worth their attention.',
    input_schema:{type:'object', properties:{
      symbol:{type:'string'}}, required:['symbol']} },

  { name:'watchlist',
    description:'Read or change the tracked-coin watchlist.',
    input_schema:{type:'object', properties:{
      action:{type:'string', enum:['list','add','remove']},
      symbol:{type:'string', description:'Required for add and remove'}}, required:['action']} }
];

/*  Gemini's function-declaration schema is the same shape as Anthropic's
    input_schema — object/properties/required/items/enum — except the "type"
    values are the proto enum's uppercase names rather than JSON Schema's
    lowercase ones. One tool list, one recursive conversion, so the two
    backends can never drift out of sync with each other.                    */
const GEMINI_TYPE = {object:'OBJECT', string:'STRING', integer:'INTEGER',
                      number:'NUMBER', boolean:'BOOLEAN', array:'ARRAY'};
function toGeminiSchema(schema){
  if(!schema || typeof schema !== 'object') return schema;
  const out = {};
  if(schema.type) out.type = GEMINI_TYPE[schema.type] || String(schema.type).toUpperCase();
  if(schema.description) out.description = schema.description;
  if(schema.enum) out.enum = schema.enum;
  if(schema.items) out.items = toGeminiSchema(schema.items);
  if(schema.properties){
    out.properties = {};
    Object.keys(schema.properties).forEach(k=> out.properties[k] = toGeminiSchema(schema.properties[k]));
  }
  if(schema.required) out.required = schema.required;
  return out;
}
const GEMINI_TOOLS = [{functionDeclarations: LG_TOOLS.map(t=>(
  {name:t.name, description:t.description, parameters: toGeminiSchema(t.input_schema)}
))}];

// Load a coin into memory if it is not already there, and return its canonical ticker
async function lgEnsureCoin(code){
  const sm = symbolOf(String(code||'').trim().toUpperCase());
  if(!sm || !sm.sym) throw new Error('no symbol given');
  if(!data[sm.sym] || !stoch[sm.sym]){
    const res = await Promise.all(TFS.map(tf=>pull(sm, tf, BARS)));
    data[sm.sym] = data[sm.sym] || {};
    TFS.forEach((tf,i)=> data[sm.sym][tf.key] = mergeCandles(data[sm.sym][tf.key], res[i]));
    analyse(sm.sym);
  }
  return sm.sym;
}

/*  Returns carry the app's direction-adjusted convention, so every tool result
    that contains one says so explicitly. Without that line a bear setup's
    "+0.7%" reads as a rise when it means a fall — the single easiest way for
    an answer built on this data to be exactly backwards.                     */
const LG_SIGN_NOTE = 'Returns are direction-adjusted: + always means the call was RIGHT. '+
  'On a bear setup a positive median means price FELL by that much.';

function lgHorizons(byH, frame){
  return HORIZONS.reduce((o,h)=>{
    const st = byH && byH[h];
    o[spanLabel(frame,h)] = st ? {hit:st.win+'%', median:st.med+'%', samples:st.n} : null;
    return o;
  },{});
}

async function lgRunTool(name, input){
  input = input || {};

  if(name === 'read_coin'){
    const sym = await lgEnsureCoin(input.symbol);
    return {coin: loganContext(sym), note:'Zones grade quality, not direction. Slow frames carry more weight.'};
  }

  if(name === 'signal_history'){
    const sym = await lgEnsureCoin(input.symbol);
    const h = historyFor(sym, input.frame ? [input.frame] : null);
    const frames = {};
    Object.keys(h.frames).forEach(k=>{
      const f = h.frames[k];
      if(!f || !f.all) return;
      frames[k] = {
        scoredSignals: f.all.n,
        thinSample: f.all.n < 30,
        typicalMoveOnThisFrame: f.baseline!=null ? +f.baseline.toFixed(2)+'%' : null,
        byHorizon: lgHorizons(f.all.byH, k)
      };
    });
    const setups = Object.values(h.buckets).map(b=>{
      const ex = bucketEdge(b);
      const bk = b.backed && b.backed.byH[H_MAIN];
      return {
        setup: b.frame+' '+b.dir+' cross from '+b.zone,
        frame:b.frame, direction:b.dir, zone:b.zone,
        scoredSignals: b.sum.n,
        thinSample: b.sum.n < 30,
        beatsOrdinaryCrossOnThisFrame: isFinite(ex) ? +ex.toFixed(2)+'x' : null,
        byHorizon: lgHorizons(b.sum.byH, b.frame),
        withDivergenceBacking: (bk && bk.n>=3)
          ? {median:bk.med+'%', samples:bk.n} : 'too few to say'
      };
    }).sort((a,b)=>parseFloat(b.beatsOrdinaryCrossOnThisFrame)-parseFloat(a.beatsOrdinaryCrossOnThisFrame));
    return {symbol:sym, totalScored:h.total, frames, setups, note:LG_SIGN_NOTE,
      caveat:'In-sample, one exchange, no fees or slippage, and overlapping signals mean the samples are '+
             'less independent than the counts suggest.'};
  }

  if(name === 'assess_trade'){
    const sym = await lgEnsureCoin(input.symbol);
    const a = input.frame ? assessTrade(sym, input.frame) : bestTrade(sym);
    if(!a) return {symbol:sym, grade:'no signal', summary:'Nothing has crossed on '+sym+' recently.'};
    return {assessment:a, note:LG_SIGN_NOTE,
      howToUse:'The grade already weighs hit rate, sample size, frame-relative edge, divergence uplift, '+
        'BTC and the 200. Report it with the sample size. Never call a thin or sub-50% setup a good trade.'};
  }

  if(name === 'scan_market'){
    const prev = Object.assign({}, scanCfg);
    if(Array.isArray(input.frames) && input.frames.length) scanCfg.frames = input.frames;
    if(input.side) scanCfg.side = input.side;
    scanCfg.depth = Math.max(10, Math.min(input.depth || 60, 200));
    let rows;
    try{ await runScan(); rows = scanRows.slice(0, Math.min(input.limit || 12, 30)); }
    finally{ Object.assign(scanCfg, prev); buildScanControls(); }
    return {scanned:scanCfg.depth, returned:rows.length, results: rows.filter(r=>r&&r.setup).map(r=>({
      symbol:r.sym, price:r.price, change24h:+r.chg.toFixed(2)+'%',
      direction:r.setup.dir, frame:r.setup.frame, zone:r.setup.zone,
      score:r.setup.score, barsSinceCross:r.setup.barsAgo,
      settled: !r.setup.pending, vsBtc:r.setup.btc, vs200:r.setup.ema,
      reasons:r.setup.why
    }))};
  }

  if(name === 'find_movers'){
    const prev = Object.assign({}, newsCfg);
    if(input.window) newsCfg.win = input.window;
    if(input.min_move != null) newsCfg.minMove = input.min_move;
    let snapshot;
    try{
      await newsScan();
      snapshot = newsRows.slice(0, Math.min(input.limit || 10, 20)).map(r=>({
        symbol:r.sym, price:r.price,
        move:(r.move>=0?'+':'')+r.move.toFixed(1)+'%',
        vsBoard:(r.excess>=0?'+':'')+r.excess.toFixed(1)+'%',
        read: r.kind==='spec' ? 'coin-specific' : r.kind==='part' ? 'amplified market move' : 'market-wide',
        sharpestHour: r.sharp ? new Date(r.sharp.t).toISOString().slice(0,16)+'Z' : null,
        volumeSpike: r.volX ? r.volX.toFixed(1)+'x' : null,
        positioning: r.flow ? r.flow.tag+' — '+r.flow.why : null,
        fundingPer8h: isFinite(r.funding) ? (r.funding*100).toFixed(4)+'%' : null
      }));
    } finally { Object.assign(newsCfg, prev); buildNewsControls(); recomputeNews(); }
    return {window: input.window || prev.win, boardMedian: newsMkt ? newsMkt.med.toFixed(2)+'%' : null,
            movers: snapshot};
  }

  if(name === 'coin_news'){
    const sym = String(input.symbol||'').trim().toUpperCase();
    const [feed] = await Promise.all([nvHeadlines(), nvLoadCoins()]);
    const hits = nvMatchNews({sym, coinName:nvCoinName(sym,null), sharp:null, move:0}, feed);
    return {symbol:sym, sources:newsFeedSrcs, headlines: hits.map(n=>({
      title:n.title, source:n.src, url:n.url,
      when: new Date(n.t).toISOString().slice(0,16)+'Z',
      relativeToMove: nvLagLabel(n.lag)
    })), note: hits.length ? null :
      'No headline names this coin. The major desks mostly cover BTC, ETH and regulation, so silence '+
      'here is common for mid-caps and does not mean nothing happened.'};
  }

  if(name === 'open_coin'){
    const sym = symbolOf(String(input.symbol||'').trim().toUpperCase()).sym;
    await switchSymbol(sym);
    setView('terminal');
    return {opened:sym};
  }

  if(name === 'watchlist'){
    const act = input.action;
    if(act === 'list') return {watchlist:watch};
    const sym = symbolOf(String(input.symbol||'').trim().toUpperCase()).sym;
    if(!sym) throw new Error('watchlist add/remove needs a symbol');
    if(act === 'add')    addWatch(sym);
    if(act === 'remove') removeWatch(sym);
    return {watchlist:watch, [act === 'add' ? 'added' : 'removed']:sym};
  }

  throw new Error('unknown tool: '+name);
}

// what the user sees in the transcript while Logan works
function lgToolLabel(name, input){
  const s = (input && input.symbol) ? ' ' + String(input.symbol).toUpperCase() : '';
  if(name==='read_coin')      return 'reading' + s;
  if(name==='assess_trade')   return 'grading the setup on' + s + (input.frame ? ' ('+input.frame+')' : '');
  if(name==='signal_history') return 'checking the backtest for' + s + (input.frame ? ' on '+input.frame : '');
  if(name==='scan_market')    return 'sweeping the board' + (input.depth ? ' (' + input.depth + ' coins)' : '');
  if(name==='find_movers')    return 'looking for abnormal moves';
  if(name==='coin_news')      return 'checking headlines for' + s;
  if(name==='open_coin')      return 'opening' + s + ' in the terminal';
  if(name==='watchlist')      return (input.action||'read') + ' watchlist' + s;
  return name;
}

async function lgCallAnthropic(){
  const body = {
    model: lgActiveModel(),
    max_tokens: 1500,
    system: LOGAN_SYSTEM + '\n\nTHE COIN CURRENTLY OPEN (JSON):\n' + JSON.stringify(loganContext()),
    tools: LG_TOOLS,
    messages: lgApi
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json', 'x-api-key':lgActiveKey(),
             'anthropic-version':'2023-06-01', 'anthropic-dangerous-direct-browser-access':'true'},
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if(!r.ok) throw lgApiError(j, r.status);
  return j;
}

/*  Gemini's generateContent, called the same way Google's own web playground
    calls it — a plain client-side fetch, key as a query param, no special
    browser-access header the way Anthropic needs one.                       */
async function lgCallGemini(){
  const body = {
    systemInstruction: {parts:[{text:
      LOGAN_SYSTEM + '\n\nTHE COIN CURRENTLY OPEN (JSON):\n' + JSON.stringify(loganContext())}]},
    contents: lgApi,
    tools: GEMINI_TOOLS,
    generationConfig: {maxOutputTokens: 1500}
  };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'+
    encodeURIComponent(lgActiveModel())+':generateContent?key='+encodeURIComponent(lgActiveKey());
  const r = await fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const j = await r.json();
  if(!r.ok) throw lgApiError(j, r.status);
  return j;
}

/*  An error the API actually answered with, as opposed to a call that never
    landed at all. The distinction decides what we can honestly say afterwards:
    a quota refusal is proof the request arrived and was understood, so blaming
    the page's origin at that point sends someone chasing a problem they do not
    have.                                                                     */
/*  What to actually tell someone when a turn fails. Three different things get
    reported as one "could not reach the API" otherwise, and only one of them
    is worth acting on the way the old message implied.                       */
function lgErrorHint(e){
  const msg = e.message || String(e);

  // a free-tier ceiling, not a fault — it clears on its own
  if(e.status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg)){
    const wait = /retry in ([\d.]+)\s*s/i.exec(msg);
    return lgProviderLabel()+' is rate limited: you have used up the free tier\'s allowance for '+
      'this stretch of time. Nothing is broken and nothing is lost — the conversation is still here.'+
      (wait ? ' Try again in about '+Math.ceil(parseFloat(wait[1]))+' seconds.'
            : ' Wait a minute and ask again.');
  }

  let hint = lgProviderLabel()+' could not reach the API: '+msg;
  /*  Only a call that never landed can be an origin problem. When the API
      answered — even to refuse — the origin was evidently fine, and this hint
      would be a red herring.                                                 */
  if(isFileOrigin() && !e.reached) hint += '\n\n'+FILE_HINT;
  return hint;
}

function lgApiError(j, status){
  const e = new Error((j && j.error && j.error.message) || ('request failed with '+status));
  e.reached = true;
  e.status = status;
  return e;
}

// a runaway tool result would blow the context; truncating beats failing.
// Gemini's functionResponse.response has to stay a JSON object, so a
// truncated result is wrapped rather than cut into invalid JSON.
function lgTruncated(out){
  const s = JSON.stringify(out);
  return s.length <= 24000 ? out : {truncated:true, result: s.slice(0, 24000)};
}

async function lgSend(text){
  text = (text||'').trim();
  if(!text || lgBusy) return;
  lgPush('user', text);

  // With no key there is nothing to call, so the built-in reader answers. It is
  // not a language model, has no tools, and says so.
  if(!lgHasKey()){ lgPush('assistant', await offlineAnswer(text)); return; }

  const gemini = lgCfg.provider === 'gemini';
  lgApi.push(gemini ? {role:'user', parts:[{text}]} : {role:'user', content:text});
  lgSaveChat();   // keep the two transcripts in step; lgPush above only saw the chat side
  lgBusy = true; $('lg-send').disabled = true; lgRender();

  try{
    for(let turn=0; turn<LG_MAX_TURNS; turn++){

      if(gemini){
        const j = await lgCallGemini();
        const cand = j.candidates && j.candidates[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        const calls = parts.filter(p=>p.functionCall);

        if(calls.length){
          const lead = parts.filter(p=>p.text && p.text.trim()).map(p=>p.text.trim()).join('\n');
          if(lead) lgChat.push({role:'assistant', content:lead});
          lgApi.push({role:'model', parts});   // echo the model's own turn back verbatim

          const results = [];
          for(const fc of calls){
            lgChat.push({role:'tool', content:lgToolLabel(fc.functionCall.name, fc.functionCall.args)});
            lgRender();
            let out;
            try{ out = await lgRunTool(fc.functionCall.name, fc.functionCall.args||{}); }
            catch(e){ out = {error:e.message}; }
            results.push({functionResponse:{name:fc.functionCall.name, response: lgTruncated(out)}});
          }
          lgApi.push({role:'user', parts: results});
          continue;
        }

        const outText = parts.filter(p=>p.text).map(p=>p.text).join('\n').trim();
        lgApi.push({role:'model', parts: parts.length ? parts : [{text: outText || '(no answer)'}]});
        lgBusy = false; $('lg-send').disabled = false;
        lgPush('assistant', outText || 'No response came back.');
        return;
      }

      const j = await lgCallAnthropic();

      if(j.stop_reason === 'tool_use'){
        lgApi.push({role:'assistant', content:j.content});
        const results = [];
        for(const blk of (j.content||[])){
          if(blk.type === 'text' && blk.text && blk.text.trim())
            lgChat.push({role:'assistant', content:blk.text.trim()});
          if(blk.type !== 'tool_use') continue;
          lgChat.push({role:'tool', content:lgToolLabel(blk.name, blk.input)});
          lgRender();
          let out;
          try{ out = await lgRunTool(blk.name, blk.input); }
          catch(e){ out = {error:e.message}; }
          results.push({type:'tool_result', tool_use_id:blk.id,
                        content: JSON.stringify(out).slice(0, 24000)});
        }
        lgApi.push({role:'user', content:results});
        continue;
      }

      const outText = (j.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').trim();
      lgApi.push({role:'assistant', content: outText || '(no answer)'});
      lgBusy = false; $('lg-send').disabled = false;
      lgPush('assistant', outText || 'No response came back.');
      return;
    }
    lgBusy = false; $('lg-send').disabled = false;
    lgPush('assistant', 'That used up my tool budget without landing an answer. Ask again more narrowly.');
  }catch(e){
    lgBusy = false; $('lg-send').disabled = false;
    lgChat.push({role:'assistant', content: lgErrorHint(e), error:true});
    lgSaveChat();
    lgRender();
  }
}

const LG_QUICK = [
  ['Read this coin',       'Give me your read on the coin I have open right now.'],
  ['Is this setup worth it?','Check the backtest for the cross currently showing on this coin, and tell me '+
                             'whether the history actually supports taking it. Quote the sample size.'],
  ['What is moving?',      'Find the coins that moved abnormally in the last 24 hours and tell me which ones '+
                           'moved on their own rather than with the market, and why.'],
  ['Find me a setup',      'Sweep the board on the daily and 4-hour for the best stochastic setups turning '+
                           'right now, check the backtest on the strongest one, and open it for me.'],
  ['Check my watchlist',   'Go through my watchlist and tell me which of them has the cleanest read today.']
];

function lgBuildQuick(){
  const box = $('lg-quick');
  box.innerHTML = '';
  LG_QUICK.forEach(([label, prompt])=>{
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = ()=> lgSend(prompt);
    box.appendChild(b);
  });
}

function lgSetMode(){
  const off = $('lg-offline');
  const keyed = lgHasKey();
  if(off) off.hidden = keyed;
  const el = $('lg-mode');
  if(!el) return;
  el.textContent = keyed ? lgProviderLabel() : 'built-in reader';
  el.classList.toggle('api', keyed);
  el.title = keyed
    ? 'Questions go to '+lgProviderLabel()+' through your API key'
    : 'Answers come from the built-in reader — deterministic, offline, free';
}

// switch which provider's fields are visible in the Connection panel — does
// not touch lgCfg.provider itself, which is only committed on Save
function lgShowProviderFields(p){
  document.querySelectorAll('#lg-provider button').forEach(b=>
    b.setAttribute('aria-pressed', b.dataset.provider === p));
  $('lg-anthropic-fields').hidden = $('lg-anthropic-fields-model').hidden = p !== 'anthropic';
  $('lg-gemini-fields').hidden = $('lg-gemini-fields-model').hidden = p !== 'gemini';
}

function lgInit(){
  lgLoadChat();
  $('lg-key').value = lgCfg.anthropicKey || '';
  $('lg-model').value = lgCfg.anthropicModel || '';
  $('lg-gkey').value = lgCfg.geminiKey || '';
  $('lg-gmodel').value = lgCfg.geminiModel || '';
  lgShowProviderFields(lgCfg.provider || 'anthropic');

  const base = lgHasKey()
    ? 'A key is saved in this browser. It is sent only to '+lgProviderHost()+'.'
    : 'Claude: get a key at console.anthropic.com (paid). Gemini: get a free key at aistudio.google.com '+
      '(a generous free tier, no card needed — Google may use free-tier prompts for training outside '+
      'the EU/UK/EEA). Either way the key stays in this browser and is sent only to that provider. '+
      'Leave the Gemini model blank for the newest free Flash; if it ever comes back rejected, name an '+
      'older one (gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash).';
  $('lg-keynote').textContent = isFileOrigin() ? base+' — '+FILE_HINT : base;
  lgBuildQuick();
  lgSetMode();
  lgRender();
}

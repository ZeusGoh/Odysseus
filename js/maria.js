/* maria.js — Maria, the journal analyst. Logan reads the market; Maria reads
   you. She works only over trades already closed, and her job is to find the
   pattern in them that you cannot see from inside the habit.

   She shares Logan's engine entirely — the agent loop, the three providers,
   the keys, the error handling all live in logan.js and take an agent. Nothing
   here touches a network. What is here is the brief, the tools, and the
   arithmetic they run over the journal.

   part of Odysseus */

const MARIA_CHAT_KEY = 'vl.maria.chat.v1';

/* ---------- the numbers she works from ---------- */

// closed trades only, newest first. An open trade has no outcome to learn from.
function mrClosed(){
  return journal.filter(t => t.status === 'closed' && jR(t, t.exitPrice) != null)
                .sort((a,b) => b.exitTime - a.exitTime);
}

/*  How aligned the board was, bucketed. The raw alignment number is a weighted
    -1…+1; what makes a readable finding is "trades taken with the board" versus
    "trades taken against it", so it is cut into named bands.                 */
const MR_ALIGN_BANDS = ['against', 'mixed', 'with'];
function mrAlignBand(t){
  if(t.alignment == null) return null;
  if(t.alignment >=  0.34) return 'with';
  if(t.alignment <= -0.34) return 'against';
  return 'mixed';
}

/*  The per-frame question that the single traded frame could never answer:
    when the 1W was leaning the other way, how did it go? One row per frame,
    split by whether that frame agreed with the trade.                        */
function mrFrameAgreement(rows){
  const out = {};
  rows.forEach(t=>{
    const r = jR(t, t.exitPrice);
    if(r == null || !t.frames) return;
    t.frames.forEach(f=>{
      const agreed = (t.direction === 'short') ? (f.side === 'bear') : (f.side === 'bull');
      const slot = (out[f.frame] = out[f.frame] || {agreed:[], against:[]});
      (agreed ? slot.agreed : slot.against).push(r);
    });
  });
  const stat = a => a.length
    ? {n:a.length, winRate:Math.round(a.filter(x=>x>0).length/a.length*100),
       avgR:+(a.reduce((s,x)=>s+x,0)/a.length).toFixed(2)}
    : null;
  return TFS.map(tf=>tf.key).filter(k=>out[k]).map(k=>(
    {frame:k, whenAgreed:stat(out[k].agreed), whenAgainst:stat(out[k].against)}));
}

// the stochastic reading of a frame at entry, bucketed the way the app buckets it
function mrZoneAgreement(rows){
  const out = {};
  rows.forEach(t=>{
    const r = jR(t, t.exitPrice);
    if(r == null || !t.frames) return;
    t.frames.forEach(f=>{
      const key = f.frame + ' ' + f.zone;
      (out[key] = out[key] || []).push(r);
    });
  });
  return Object.keys(out).filter(k=>out[k].length >= 2).map(k=>{
    const rs = out[k];
    return {condition:k, n:rs.length,
            winRate:Math.round(rs.filter(x=>x>0).length/rs.length*100),
            avgR:+(rs.reduce((s,x)=>s+x,0)/rs.length).toFixed(2)};
  }).sort((a,b)=>b.n - a.n);
}

// one trade, flattened to what is worth reasoning about
function mrTrade(t){
  return {
    id: t.id, symbol: t.symbol, frame: t.frame, direction: t.direction,
    entryPrice: t.entryPrice, exit: t.exitPrice, stop: t.invalidation, size: t.size,
    enteredAt: t.entryTime ? new Date(t.entryTime).toISOString().slice(0,16)+'Z' : null,
    closedAt:  t.exitTime  ? new Date(t.exitTime ).toISOString().slice(0,16)+'Z' : null,
    heldHours: (t.entryTime && t.exitTime) ? +((t.exitTime-t.entryTime)/36e5).toFixed(1) : null,
    R: +jR(t, t.exitPrice).toFixed(2),
    pct: +jPct(t, t.exitPrice).toFixed(2),
    gradeAtEntry: t.verdict ? t.verdict.grade : null,
    zoneAtEntry: t.verdict ? t.verdict.zone : null,
    alignment: t.alignment, alignmentBand: mrAlignBand(t),
    wave: t.wave || null, notes: t.notes || null, closeNote: t.closeNote || null,
    frames: t.frames || null
  };
}

/* ---------- tools ---------- */

const MARIA_TOOLS = [
  { name:'performance',
    description:'The headline record over every closed trade: sample size, win rate, average win and '+
      'loss in R, total R and expectancy. Call this first — everything else is only meaningful '+
      'against the size of the sample.',
    input_schema:{type:'object', properties:{}} },

  { name:'read_trades',
    description:'Closed trades in full, newest first, including the notes written at entry, the grade '+
      'at entry and the whole five-frame stochastic snapshot taken when the trade was opened. Use it '+
      'to read the actual trades rather than only their averages.',
    input_schema:{type:'object', properties:{
      limit:{type:'integer', description:'how many to return, newest first (default 20)'},
      symbol:{type:'string', description:'restrict to one coin'},
      outcome:{type:'string', enum:['all','winners','losers'], description:'default all'}}} },

  { name:'group_outcomes',
    description:'Win rate and average R grouped by one dimension: the hour of day you entered, the '+
      'weekday, the month, the stochastic zone at entry, direction, the frame traded, the grade the '+
      'verdict engine gave it, or how aligned the rest of the board was. This is where habits show up.',
    input_schema:{type:'object', properties:{
      by:{type:'string', enum:['hour','weekday','month','zone','direction','frame','grade','alignment'],
          description:'the dimension to group by'}}, required:['by']} },

  { name:'frame_agreement',
    description:'For each timeframe, how trades went when that frame was leaning with the trade versus '+
      'against it. Answers questions the single traded frame cannot: whether taking longs while the '+
      'weekly is rolling over actually costs anything.',
    input_schema:{type:'object', properties:{}} },

  { name:'zone_outcomes',
    description:'Win rate and average R for each frame-and-zone combination at entry — "4H oversold", '+
      '"1D overbought" and so on — across every closed trade that carries a snapshot.',
    input_schema:{type:'object', properties:{}} }
];

const MR_GROUPERS = {
  hour:      {fn: jHourBlockOf, order: J_HOUR_BLOCKS},
  weekday:   {fn: jWeekdayOf,   order: null},
  month:     {fn: jMonthOf,     order: null},
  zone:      {fn: t => (t.verdict && t.verdict.zone) || null, order: ['oversold','middle','overbought']},
  direction: {fn: t => t.direction, order: ['long','short']},
  frame:     {fn: t => t.frame, order: TFS.map(x=>x.key)},
  grade:     {fn: t => (t.verdict && t.verdict.grade) || null, order: null},
  alignment: {fn: mrAlignBand, order: MR_ALIGN_BANDS}
};

/*  Every tool ships the sample size with its answer, and the system prompt is
    told to quote it. A win rate over four trades is noise wearing a number,
    and an analyst that does not say so is worse than none.                   */
async function mrRunTool(name, input){
  input = input || {};
  const rows = mrClosed();

  if(name === 'performance'){
    const s = jStats(journal);
    if(!s) return {note:'No closed trades yet. Nothing to analyse until some trades are closed out.'};
    return Object.assign({}, s, {
      withSnapshots: rows.filter(t=>t.frames && t.frames.length).length,
      note: rows.length < 20
        ? 'Small sample — '+rows.length+' closed trades. Treat any split of this as suggestive, not settled.'
        : null
    });
  }

  if(name === 'read_trades'){
    let out = rows;
    if(input.symbol) out = out.filter(t=>t.symbol === String(input.symbol).toUpperCase());
    if(input.outcome === 'winners') out = out.filter(t=>jR(t, t.exitPrice) > 0);
    if(input.outcome === 'losers')  out = out.filter(t=>jR(t, t.exitPrice) <= 0);
    const limit = Math.max(1, Math.min(60, input.limit || 20));
    return {n: out.length, returned: Math.min(limit, out.length),
            trades: out.slice(0, limit).map(mrTrade)};
  }

  if(name === 'group_outcomes'){
    const g = MR_GROUPERS[input.by];
    if(!g) return {error:'unknown dimension: '+input.by};
    const stats = jGroupStats(journal, g.fn, g.order);
    return {by: input.by, groups: stats,
            note: 'Each group carries its own n. A group of fewer than five trades is not a finding.'};
  }

  if(name === 'frame_agreement'){
    const f = mrFrameAgreement(rows);
    return f.length ? {frames:f} : {note:'No closed trade carries a five-frame snapshot yet. Snapshots '+
      'began being recorded recently, so this fills in as new trades are logged and closed.'};
  }

  if(name === 'zone_outcomes'){
    const z = mrZoneAgreement(rows);
    return z.length ? {conditions:z} : {note:'No closed trade carries a five-frame snapshot yet.'};
  }

  return {error:'unknown tool: '+name};
}

function mrToolLabel(name, input){
  input = input || {};
  if(name === 'performance')     return 'reading the record';
  if(name === 'read_trades')     return 'reading trades'+(input.symbol ? ' on '+String(input.symbol).toUpperCase() : '')+
                                        (input.outcome && input.outcome!=='all' ? ' ('+input.outcome+')' : '');
  if(name === 'group_outcomes')  return 'grouping by '+(input.by||'');
  if(name === 'frame_agreement') return 'checking frame agreement';
  if(name === 'zone_outcomes')   return 'checking zones at entry';
  return name;
}

const MARIA_SYSTEM = `You are Maria, the journal analyst built into ODYSSEUS, a stochastic terminal for
crypto perpetuals. Logan reads the market. You read the trader.

Your material is closed trades only — trades with an outcome. You have tools for the record, the trades
themselves including the notes written at entry, groupings by when and how they were taken, and the
five-frame stochastic snapshot captured at each entry.

How to work:
- Call performance first. Everything after it is only meaningful against the sample size.
- Quote n every time you state a rate. A 70% win rate over six trades is noise, and you say so.
- Prefer a finding that suggests an action. "Your 1H longs taken while the daily was overbought lost on
  nine of eleven" is worth more than a list of averages.
- Look at the notes. What someone wrote at entry is often the tell that the numbers only confirm.
- Distinguish what the data supports from what you suspect, out loud.
- If a pattern has no sample behind it, say there is nothing there yet rather than inventing one.
- Never invent a number. Every figure you cite comes from a tool result.

Tone: plain prose, a few short paragraphs. Direct rather than gentle — the point of a journal is to be
told the thing you would rather not notice. No headers, no bullet lists unless comparing several groups.
No emoji.

You are describing what the record shows. You do not tell the user what to trade next, you do not predict
prices, and you do not suggest position sizes or leverage. The decisions stay theirs.`;

const MARIA_QUICK = [
  ['What should I fix?',   'Look at my whole record and tell me the single most costly habit in it. Quote the sample size.'],
  ['When do I trade worst?','Group my trades by hour and by weekday and tell me whether when I trade actually matters.'],
  ['Am I fighting the board?','Check how my trades go when the higher frames agreed with me versus when they did not.'],
  ['Which zone suits me?', 'Compare my outcomes by the stochastic zone at entry, across frames, and tell me where my edge actually is.'],
  ['Read my losers',       'Read my losing trades including the notes I wrote at entry, and tell me what they have in common.']
];

/*  With no key there is no model, and unlike Logan there is no deterministic
    fallback worth pretending is an analyst — the whole job is judgement over a
    record. So she says what she is and points at the panels that do work
    offline rather than producing a hollow imitation of a read.               */
async function mrOffline(){
  const s = jStats(journal);
  const n = s ? s.n : 0;
  return 'I need a model to do this — my job is reading your record, not reciting it, and there is no '+
    'offline version of that worth having.\n\n'+
    (n ? 'You have '+n+' closed trades logged'+(s ? ', win rate '+s.winRate+'%, expectancy '+
         s.expectancy+'R' : '')+'. The Performance and Patterns panels in the Journal show the same '+
         'breakdowns I would read from, and they work without a key.'
       : 'You have no closed trades yet in any case — close a few and there will be something to read.')+
    '\n\nAdd a free Gemini or OpenRouter key under Connection to switch me on.';
}

const MARIA = agentMake({
  id:'maria', name:'Maria', chatKey: MARIA_CHAT_KEY,
  tools: MARIA_TOOLS, run: mrRunTool, label: mrToolLabel, quick: MARIA_QUICK,
  dom: {log:'mr-log', send:'mr-send', quick:'mr-quick', mode:'mr-mode', offline:'mr-offline',
        sessions:'mr-sessions'},
  system: ()=> MARIA_SYSTEM,
  offline: mrOffline,
  empty: (keyed)=> '<div class="lgempty"><b>Maria reads your trade history, not the market.</b>'+
    (keyed
      ? 'She works over closed trades only: the record, the notes you wrote at entry, and the '+
        'stochastic picture across all five frames at the moment you took each one. Ask her what to '+
        'fix and she will go and look. Running on '+lgProviderLabel()+'.'
      : 'She needs a model — reading a record is judgement, and there is no offline version of that '+
        'worth having. Add a free key under <b>Connection</b> in Logan to switch her on; the two '+
        'agents share it.')+
    '</div>'
});

function mrSend(text){ return agSend(MARIA, text); }
function mrRender(cls){ return agRender(MARIA, cls); }
function mrForgetChat(){ return agForgetChat(MARIA); }

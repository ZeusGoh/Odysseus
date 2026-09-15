/* paul.js — Paul, the anomaly analyst. Logan reads the market, Maria reads the
   trader, Paul reads the detector.

   His subject is narrower than either and more sceptical: the anomaly log is a
   record of claims the app made — "this move is abnormal", "this coin is about
   to expand" — each one scored against what actually happened one, four and
   twenty-four hours later. His job is to say whether those claims are worth
   anything, and which kinds are worth less than they look.

   Same engine as the others; see logan.js. Nothing here touches a network.
   part of Odysseus */

const PAUL_CHAT_KEY = 'vl.paul.chat.v1';

/* ---------- the record he works from ---------- */

// a flag is only evidence once at least one of its checks has resolved
function plScored(rows){
  return (rows||[]).filter(e => e && e.checks &&
    ANOM_CHECKS.some(h => e.checks[h] && e.checks[h].grade));
}

/*  `type` separates coiled flags from move flags; `kind` is the move flag's own
    classification (spec / part / mkt). Confusing the two silently returns an
    empty record, which reads exactly like "nothing logged yet".              */
function plMoveFlags(){ return anomNewestFirst(anomalies.filter(e => e.type !== 'coiled')); }
function plCoilFlags(){ return anomNewestFirst(anomalies.filter(e => e.type === 'coiled')); }

// one flag, flattened to what is worth reasoning about
function plFlag(e){
  const checks = {};
  ANOM_CHECKS.forEach(h=>{
    const c = e.checks && e.checks[h];
    if(!c) return;
    checks['h'+h] = c.state === 'expired' ? {missed:true}
                                        : {grade:c.grade, rawPct:c.raw, excessPct:c.excess};
  });
  return {
    symbol: e.sym,
    at: e.at ? new Date(e.at).toISOString().slice(0,16)+'Z' : null,
    direction: e.dir, movePct: e.move, excessVsBoard: e.excess,
    boardMedian: e.boardMed, classification: e.kind,
    outcomes: Object.keys(checks).length ? checks : null
  };
}

function plCoil(e){
  const checks = {};
  ANOM_CHECKS.forEach(h=>{
    const c = e.checks && e.checks[h];
    if(!c) return;
    checks['h'+h] = c.state === 'expired' ? {missed:true}
                                        : {grade:c.grade, rangeRatio:c.ratio, brokePct:c.move};
  });
  return {
    symbol: e.sym,
    at: e.at ? new Date(e.at).toISOString().slice(0,16)+'Z' : null,
    signals: e.signals || null,
    compression: e.compression, volRatio: e.volRatio, oiChangePct: e.oiChg,
    outcomes: Object.keys(checks).length ? checks : null
  };
}

/*  Per coin, how its flags have resolved. The question behind it is whether
    the detector is uniformly useful or whether it is really only picking up
    something about a handful of names.                                      */
function plByCoin(rows, minN){
  const out = {};
  plScored(rows).forEach(e=>{
    const held = ANOM_CHECKS.some(h => e.checks[h] && e.checks[h].grade === 'held');
    const slot = (out[e.sym] = out[e.sym] || {n:0, held:0});
    slot.n++; if(held) slot.held++;
  });
  return Object.keys(out)
    .filter(k => out[k].n >= (minN || 2))
    .map(k => ({symbol:k, n:out[k].n, held:out[k].held,
                heldPct: Math.round(out[k].held/out[k].n*100)}))
    .sort((a,b)=> b.n - a.n);
}

/* ---------- tools ---------- */

const PAUL_TOOLS = [
  { name:'detector_record',
    description:'The headline track record of the move detector: for each classification the app '+
      'assigns — coin-specific, amplified, market-wide — what share of flags held, faded or reversed '+
      'at +1h, +4h and +24h, with the sample behind each. Call this first; nothing else means much '+
      'without it.',
    input_schema:{type:'object', properties:{}} },

  { name:'read_flags',
    description:'Individual move flags, newest first, each with what the detector called it at the '+
      'time and how it resolved at each checkpoint. Use it to read the actual flags rather than only '+
      'their averages.',
    input_schema:{type:'object', properties:{
      limit:{type:'integer', description:'how many to return, newest first (default 25)'},
      symbol:{type:'string', description:'restrict to one coin'},
      classification:{type:'string', enum:['spec','part','mkt'],
        description:'spec = coin-specific, part = amplified with the board, mkt = market-wide'},
      settled:{type:'boolean', description:'true returns only flags that have at least one resolved check'}}} },

  { name:'coiled_record',
    description:'The track record of the coiled detector, which claims a range is about to widen. '+
      'Scored on whether it actually expanded, in either direction, against the coin\'s own prior '+
      'range — a directionless claim scored directionlessly.',
    input_schema:{type:'object', properties:{}} },

  { name:'read_coiled',
    description:'Individual coiled flags with the signals that fired on them — compression, volume, '+
      'open interest — and whether the range expanded afterwards.',
    input_schema:{type:'object', properties:{
      limit:{type:'integer', description:'how many to return, newest first (default 25)'},
      symbol:{type:'string'}}} },

  { name:'by_coin',
    description:'How flags have resolved per coin, for coins with more than one scored flag. Shows '+
      'whether the detector works across the board or is really only describing a few names.',
    input_schema:{type:'object', properties:{
      kind:{type:'string', enum:['move','coiled'], description:'default move'},
      min_flags:{type:'integer', description:'minimum scored flags for a coin to appear (default 2)'}}} }
];

const PL_THIN_NOTE = 'Anything under '+ANOM_THIN+' scored flags is marked thin and should be read as '+
  'suggestive, not settled.';

async function plRunTool(name, input){
  input = input || {};

  if(name === 'detector_record'){
    const st = anomStats(anomalies);
    if(!st || !st.total) return {note:'No flags logged yet. Run a sweep in the Anomaly view and the '+
      'record starts building; it needs days before it says anything.'};
    return Object.assign({}, st, {checkpointsHours: ANOM_CHECKS, note: PL_THIN_NOTE});
  }

  if(name === 'read_flags'){
    let rows = plMoveFlags();
    if(input.symbol) rows = rows.filter(e => e.sym === String(input.symbol).toUpperCase());
    if(input.classification) rows = rows.filter(e => e.kind === input.classification);
    if(input.settled) rows = plScored(rows);
    const limit = Math.max(1, Math.min(60, input.limit || 25));
    return {n: rows.length, returned: Math.min(limit, rows.length),
            flags: rows.slice(0, limit).map(plFlag)};
  }

  if(name === 'coiled_record'){
    const st = anomCoiledStats(anomalies);
    if(!st || !st.n) return {note:'No coiled flags logged yet.'};
    return Object.assign({}, st, {checkpointsHours: ANOM_CHECKS, note: PL_THIN_NOTE});
  }

  if(name === 'read_coiled'){
    let rows = plCoilFlags();
    if(input.symbol) rows = rows.filter(e => e.sym === String(input.symbol).toUpperCase());
    const limit = Math.max(1, Math.min(60, input.limit || 25));
    return {n: rows.length, returned: Math.min(limit, rows.length),
            coiled: rows.slice(0, limit).map(plCoil)};
  }

  if(name === 'by_coin'){
    const rows = input.kind === 'coiled' ? plCoilFlags() : plMoveFlags();
    const out = plByCoin(rows, input.min_flags);
    return out.length ? {kind: input.kind || 'move', coins: out}
                      : {note:'No coin has more than one scored flag yet.'};
  }

  return {error:'unknown tool: '+name};
}

function plToolLabel(name, input){
  input = input || {};
  const on = input.symbol ? ' on '+String(input.symbol).toUpperCase() : '';
  if(name === 'detector_record') return 'reading the detector record';
  if(name === 'read_flags')      return 'reading flags'+on;
  if(name === 'coiled_record')   return 'reading the coiled record';
  if(name === 'read_coiled')     return 'reading coiled flags'+on;
  if(name === 'by_coin')         return 'breaking it down by coin';
  return name;
}

const PAUL_SYSTEM = `You are Paul, the anomaly analyst built into ODYSSEUS, a stochastic terminal for
crypto perpetuals. Logan reads the market and Maria reads the trader. You read the detector.

Your material is the anomaly log: every time the app flagged a move as abnormal, or flagged a coin as
compressed and due to expand, written down at the moment it fired and scored against what actually
happened at +1h, +4h and +24h. A move flag resolves as held, faded or reversed. A coiled flag makes a
directionless claim and is scored on whether the range widened at all.

Your job is scepticism with arithmetic behind it. The detector makes claims; you say what they are
worth.

How to work:
- Call detector_record first. Every other answer is read against that sample.
- Quote n every time you state a rate, and say when a sample is thin. Under ${ANOM_THIN} scored flags is
  marked thin by the tools themselves and you should repeat that, not bury it.
- A flag that fades is not a failure of the app, it is information about which kinds of move continue.
  Say which kinds do.
- Watch for the record being carried by a few names — by_coin exists for exactly that.
- Distinguish what the record supports from what you suspect, out loud. If there is not enough here to
  say anything yet, say that rather than dressing up noise.
- Never invent a number. Every figure comes from a tool result.

Tone: plain prose, a few short paragraphs. Direct. No headers, no bullet lists unless comparing several
groups. No emoji.

You describe what the record shows. You do not tell the user what to trade, you do not predict prices,
and you do not suggest position sizes or leverage.`;

const PAUL_QUICK = [
  ['Is the detector any good?','Read the detector record and tell me plainly whether a flag means anything yet, and at which horizon.'],
  ['Which flags hold?',        'Compare the classifications — coin-specific, amplified, market-wide — and tell me which kind of flag actually continues.'],
  ['Does coiling work?',       'Read the coiled record and tell me whether compression really does precede expansion, with the sample.'],
  ['Any coin carrying it?',    'Break the record down by coin and tell me whether a few names are carrying the whole thing.'],
  ['Read the recent flags',    'Read the most recent flags and tell me what actually happened to them.']
];

async function plOffline(){
  const st = anomStats(anomalies);
  const n = st ? st.total : 0;
  return 'I need a model for this — the arithmetic is already on the Anomaly History page, and '+
    'repeating it back to you is not analysis.\n\n'+
    (n ? n+' flags are logged, '+(st.settled||0)+' of them scored. The Detector track record panel '+
         'shows the same rates I would read from, and it works without a key.'
       : 'Nothing is logged yet in any case — run a sweep in the Anomaly view and the record starts '+
         'building.')+
    '\n\nAdd a free Gemini or OpenRouter key under Connection to switch me on.';
}

const PAUL = agentMake({
  id:'paul', name:'Paul', chatKey: PAUL_CHAT_KEY,
  tools: PAUL_TOOLS, run: plRunTool, label: plToolLabel, quick: PAUL_QUICK,
  dom: {log:'pl-log', send:'pl-send', quick:'pl-quick', mode:'pl-mode', offline:'pl-offline',
        sessions:'pl-sessions'},
  system: ()=> PAUL_SYSTEM,
  offline: plOffline,
  empty: (keyed)=> '<div class="lgempty"><b>Paul reads the detector, not the market.</b>'+
    (keyed
      ? 'Every abnormal move the app has flagged, and every coil, scored against what happened one, '+
        'four and twenty-four hours later. He will tell you which kinds of flag are worth acting on '+
        'and which are noise with a label. Running on '+lgProviderLabel()+'.'
      : 'He needs a model — the arithmetic is already on the Anomaly History page, and reading it '+
        'aloud is not analysis. Add a free key under <b>Connection</b>; all three agents share it.')+
    '</div>'
});

function plSend(text){ return agSend(PAUL, text); }
function plRender(cls){ return agRender(PAUL, cls); }
function plForgetChat(){ return agForgetChat(PAUL); }

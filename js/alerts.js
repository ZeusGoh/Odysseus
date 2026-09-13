/* alerts.js — Alerts — what is worth announcing, Telegram and browser delivery, and the
   alerts view UI. Outbound messages stay behind an explicit human switch.
   part of VL */

/* ---------- alerts ----------
   Watches the tracked coins in the background and delivers once per event.
   Deduplication is keyed on the exact bar a signal printed on, so a cross is
   announced once and never repeated as the bar ticks.                       */
const ALERT_KEY = 'vl.alerts.v1', FIRED_KEY = 'vl.fired.v1';

const alertCfg = Object.assign({
  on:false,
  frames:['1D','4H'],
  confirmed:true,      // a cross that has settled
  unsettled:false,     // a cross on the live bar, can still unwind
  nearing:false,       // %K turning into %D
  divergence:true,
  withBtc:false,       // only when the setup agrees with BTC
  browser:true,
  token:'', chat:'',
  every:60
}, (()=>{ try{ return JSON.parse(localStorage.getItem(ALERT_KEY)||'{}'); }catch(e){ return {}; } })());

let fired = (()=>{ try{ return new Set(JSON.parse(localStorage.getItem(FIRED_KEY)||'[]')); }
                   catch(e){ return new Set(); } })();
let alertBusy = false, alertLog = [];

function saveAlertCfg(){
  try{ localStorage.setItem(ALERT_KEY, JSON.stringify(alertCfg)); return true; }catch(e){ return false; }
}
function rememberFired(key){
  fired.add(key);
  if(fired.size > 400) fired = new Set([...fired].slice(-300));   // keep it bounded
  try{ localStorage.setItem(FIRED_KEY, JSON.stringify([...fired])); }catch(e){}
}

async function sendTelegram(text){
  if(!alertCfg.token || !alertCfg.chat) return {ok:false, why:'no token or chat id'};
  try{
    const r = await fetch('https://api.telegram.org/bot'+alertCfg.token.trim()+'/sendMessage', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id:alertCfg.chat.trim(), text, disable_web_page_preview:true})
    });
    const j = await r.json().catch(()=>({}));
    if(!r.ok || j.ok===false) return {ok:false, why:(j && j.description) || ('HTTP '+r.status)};
    return {ok:true};
  }catch(e){ return {ok:false, why:e.message}; }
}

function notifyBrowser(title, body){
  if(!alertCfg.browser) return;
  try{
    if(typeof Notification==='undefined') return;
    if(Notification.permission==='granted') new Notification(title, {body});
  }catch(e){}
}

async function deliver(title, body){
  notifyBrowser(title, body);
  const res = await sendTelegram(title+'\n'+body);
  alertLog.unshift({t:Date.now(), title, body, tg:res.ok ? 'sent' : (res.why||'off')});
  alertLog = alertLog.slice(0, 40);
  if(view==='alerts') renderAlertLog();
}

// what, if anything, is worth announcing about one coin on one frame
function alertEvents(code, key){
  const st = states[code] && states[code][key];
  const sd = stoch[code] && stoch[code][key];
  if(!st || !sd || !sd.candles.length) return [];
  const out = [];
  const barT = (st.at!=null && sd.candles[st.at]) ? sd.candles[st.at].t : sd.candles[sd.candles.length-1].t;

  const withBtc = () => {
    if(!alertCfg.withBtc) return true;
    if(code===BTC) return true;
    return btcVerdict(st.dir, key).tone==='up';
  };

  if(alertCfg.confirmed && (st.type==='bull'||st.type==='bear') && st.fresh && withBtc())
    out.push({key:code+'|'+key+'|conf|'+barT, kind:'confirmed', dir:st.dir, st});
  if(alertCfg.unsettled && st.pending && withBtc())
    out.push({key:code+'|'+key+'|live|'+barT, kind:'unsettled', dir:st.dir, st});
  if(alertCfg.nearing && st.nearing && withBtc())
    out.push({key:code+'|'+key+'|near|'+barT, kind:'nearing', dir:st.dir, st});

  const dv = divNow[code] && divNow[code][key];
  if(alertCfg.divergence && dv && (dv.pending || dv.barsAgo<=2)){
    const dT = sd.candles[dv.to] ? sd.candles[dv.to].t : barT;
    if(!alertCfg.withBtc || code===BTC || btcVerdict(dv.dir, key).tone==='up')
      out.push({key:code+'|'+key+'|div|'+dT, kind:'divergence', dir:dv.dir, dv});
  }
  return out;
}

function alertText(code, key, ev){
  const meta = symbolOf(code);
  const arrow = ev.dir==='bull' ? 'LONG' : 'SHORT';
  const head = 'VL · '+meta.sym+' '+key+' '+arrow+' — '+
    (ev.kind==='confirmed' ? 'cross confirmed'
     : ev.kind==='unsettled' ? 'cross on the live bar'
     : ev.kind==='nearing' ? '%K turning into %D'
     : 'divergence');
  const bits = [];
  if(ev.st){
    bits.push('%K '+ev.st.k.toFixed(1)+' / %D '+ev.st.d.toFixed(1));
    if(ev.st.level!=null) bits.push('fired at '+ev.st.level.toFixed(1)+' ('+zoneOf(ev.st.level)+')');
    if(ev.kind==='unsettled') bits.push('unconfirmed until the bar closes');
    if(ev.kind==='nearing' && isFinite(ev.st.eta)) bits.push('~'+Math.round(ev.st.eta)+' bars at this pace');
  }
  if(ev.dv) bits.push('run across '+(ev.dv.legs+1)+' swings'+(ev.dv.pending?', still forming':''));
  const sc = states[code] ? bias(states[code], WEIGHTS) : null;
  if(sc!=null) bits.push('composite '+(sc>0?'+':'')+sc);
  if(code!==BTC && states[BTC]){
    const al = alignBtc(states[code]);
    if(al.n) bits.push(al.pct>=40 ? 'with BTC' : al.pct<=-40 ? 'against BTC' : 'BTC split');
  }
  const e = stoch[code] && stoch[code][key] && stoch[code][key].ema;
  if(e && e.ok) bits.push(e.above ? 'above the 200' : 'below the 200');
  return {title:head, body:bits.join(' · ')};
}

async function alertTick(){
  if(!alertCfg.on || alertBusy || !watch.length) return;
  alertBusy = true;
  try{
    for(const code of watch){
      try{
        const meta = symbolOf(code);
        const first = !data[code];
        const res = await Promise.all(TFS.filter(t=>alertCfg.frames.includes(t.key))
                                         .map(tf=>pull(meta, tf, first?BARS:TAIL)));
        data[code] = data[code] || {};
        TFS.filter(t=>alertCfg.frames.includes(t.key)).forEach((tf,i)=>{
          data[code][tf.key] = mergeCandles(data[code][tf.key], res[i]);
        });
        analyse(code);
      }catch(e){ continue; }

      for(const key of alertCfg.frames){
        for(const ev of alertEvents(code, key)){
          if(fired.has(ev.key)) continue;
          rememberFired(ev.key);
          const msg = alertText(code, key, ev);
          await deliver(msg.title, msg.body);
        }
      }
    }
  } finally { alertBusy = false; }
}

/* ---------- alerts UI ---------- */
function renderAlertLog(){
  const box = $('a-log');
  $('a-count').textContent = alertLog.length
    ? alertLog.length+' sent this session'
    : 'nothing sent yet this session';
  if(!alertLog.length){
    box.innerHTML = '<div class="loading">Alerts you receive will be listed here.</div>';
    return;
  }
  box.innerHTML = '';
  alertLog.forEach(a=>{
    const el = document.createElement('div');
    el.className = 'alrow';
    const cls = a.tg==='sent' ? 'sent' : a.tg==='off' ? '' : 'fail';
    el.innerHTML =
      '<div class="altime">'+new Date(a.t).toLocaleTimeString()+'</div>'+
      '<div><span class="altitle">'+a.title+'</span><span class="albody">'+a.body+'</span></div>'+
      '<div class="altg '+cls+'">'+a.tg+'</div>';
    box.appendChild(el);
  });
}

function renderAlertBadge(){
  const b = $('alert-dot');
  b.textContent = alertCfg.on ? 'on' : 'off';
  b.classList.toggle('armed', alertCfg.on);
}

function buildAlertControls(){
  const chip = (host, items, isOn, pick) => {
    const box = $(host); box.innerHTML = '';
    items.forEach(([val,label])=>{
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', isOn(val));
      b.onclick = ()=>{ pick(val); saveAlertCfg(); buildAlertControls(); };
      box.appendChild(b);
    });
  };
  chip('a-frames', TFS.map(t=>[t.key,t.key]),
       v=>alertCfg.frames.includes(v),
       v=>{ alertCfg.frames = alertCfg.frames.includes(v)
              ? alertCfg.frames.filter(x=>x!==v)
              : TFS.filter(t=>t.key===v||alertCfg.frames.includes(t.key)).map(t=>t.key);
            if(!alertCfg.frames.length) alertCfg.frames=[v]; });
  chip('a-events', [['confirmed','Confirmed cross'],['unsettled','Live-bar cross'],
                    ['nearing','Nearing'],['divergence','Divergence']],
       v=>!!alertCfg[v], v=>{ alertCfg[v] = !alertCfg[v]; });
  chip('a-filter', [['withBtc','With BTC only']],
       v=>!!alertCfg[v], v=>{ alertCfg[v] = !alertCfg[v]; });
  chip('a-every', [[30,'30s'],[60,'1m'],[300,'5m']],
       v=>alertCfg.every===v, v=>{ alertCfg.every=v; restartAlertTimer(); });
  $('a-on').checked = alertCfg.on;
  $('a-token').value = alertCfg.token || '';
  $('a-chat').value  = alertCfg.chat  || '';
  $('a-note').textContent = alertCfg.token && alertCfg.chat
    ? 'Telegram is configured. Messages go straight to your chat.'
    : 'Create a bot with @BotFather, paste its token, then message the bot once and put your chat id here. Get the id from @userinfobot.';
  renderAlertBadge();
}

let alertTimer = null;
function restartAlertTimer(){
  if(alertTimer) clearInterval(alertTimer);
  alertTimer = setInterval(alertTick, Math.max(15, alertCfg.every||60)*1000);
}

async function armAlerts(on){
  alertCfg.on = on;
  if(on && alertCfg.browser && typeof Notification!=='undefined'){
    try{ if(Notification.permission==='default') await Notification.requestPermission(); }catch(e){}
  }
  saveAlertCfg();
  renderAlertBadge();
  $('asub').textContent = on
    ? 'Armed — watching '+watch.length+' tracked coin'+(watch.length===1?'':'s')+' on '+alertCfg.frames.join(', ')
    : 'Watches your tracked coins in the background and tells you once per signal.';
  if(on) alertTick();
}

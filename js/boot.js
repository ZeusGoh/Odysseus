/* boot.js — Boot. Every DOM wiring line and every start-up call, in their original order.
   Loaded last, so everything it touches is already defined.
   part of Odysseus */

/* ---------- nav menu ---------- */
$('navbtn').onclick = e=>{ e.stopPropagation(); navOpen(); };
// click anywhere else, or Escape, closes it — the panel overlays the page, so leaving
// it open while you work on what is underneath is never what you meant
document.addEventListener('click', e=>{
  if(!$('navpanel').hidden && !(e.target.closest && e.target.closest('.navwrap'))) navOpen(false);
});
addEventListener('keydown', e=>{ if(e.key==='Escape') navOpen(false); });

$('trackbtn').onclick = ()=>{
  if(watch.includes(active)) removeWatch(active);
  else addWatch(active);
};
$('waddbtn').onclick = ()=>{
  const hits = searchSymbols($('wsearch').value);
  addWatch(hits.length ? hits[0].sym : $('wsearch').value);
};
$('nav-scan').onclick  = ()=> setView('scan');
$('sc-run').onclick    = runScan;
$('sc-stop').onclick   = ()=>{ scanAbort = true; };
$('nav-alerts').onclick = ()=> setView('alerts');
$('a-on').onchange = e=> armAlerts(e.target.checked);
$('a-save').onclick = ()=>{
  alertCfg.token = $('a-token').value.trim();
  alertCfg.chat  = $('a-chat').value.trim();
  const ok = saveAlertCfg();
  $('a-note').textContent = ok
    ? 'Saved in this browser. The token is sent only to api.telegram.org.'
    : 'This preview cannot save, so these last only for the session.';
};
$('a-test').onclick = async ()=>{
  $('a-test').textContent = 'Sending…';
  const res = await sendTelegram('ODYSSEUS test alert — if you can read this, Telegram is wired up correctly.');
  notifyBrowser('ODYSSEUS test alert', 'Browser notifications are working.');
  alertLog.unshift({t:Date.now(), title:'ODYSSEUS test alert', body:'manual test',
                    tg: res.ok ? 'sent' : (res.why||'off')});
  renderAlertLog();
  $('a-test').textContent = res.ok ? 'Sent' : 'Failed';
  if(!res.ok) $('a-note').textContent = 'Telegram refused it: '+(res.why||'unknown')+
    '. Check the token, and make sure you have sent your bot a message first.';
  setTimeout(()=>{ $('a-test').textContent = 'Send test'; }, 2000);
};
$('nav-hist').onclick  = ()=> setView('hist');
$('h-run').onclick     = buildHistory;
$('nav-sessions').onclick = ()=> setView('sessions');

/* ---------- journal ---------- */
$('nav-journal').onclick = ()=> setView('journal');
$('j-new').onclick = ()=> jOpenForm();
$('j-cancel').onclick = ()=>{ $('j-form').hidden = true; };
$('j-save').onclick = jSaveForm;
$('j-refresh').onclick = ()=> jRefreshPrices(($('j-sym').value||'').trim().toUpperCase() || undefined);
document.querySelectorAll('#j-dir button').forEach(b=>{
  b.onclick = ()=> jSetDir(b.dataset.dir);
});
$('j-sym').addEventListener('input', jUpdateVerdictPreview);
$('j-frame').addEventListener('change', jUpdateVerdictPreview);
$('j-entrytime').addEventListener('change', jUpdateVerdictPreview);
$('j-entry').addEventListener('input', jFillSuggestedSize);
$('j-inval').addEventListener('input', jFillSuggestedSize);
/*  The account, the percentage and the dollar amount are one setting wearing
    three hats. Editing any of them re-derives the others and re-states the
    working, so the panel can never show a risk it is not actually using.     */
$('j-account').addEventListener('input', ()=>{ jSyncRisk('pct'); });
$('j-riskpct').addEventListener('input', ()=>{ jSyncRisk('pct'); });
$('j-riskusd').addEventListener('input', ()=>{ jSyncRisk('usd'); });
['j-account','j-riskpct','j-riskusd'].forEach(id=>{
  $(id).addEventListener('change', ()=>{
    jCfg.account = parseFloat($('j-account').value) || jCfg.account;
    jCfg.riskPct = parseFloat($('j-riskpct').value) || jCfg.riskPct;
    jCfg.riskUsd = parseFloat($('j-riskusd').value) || jCfg.riskUsd;
    jSaveCfg();
  });
});
// one delegated listener per table rather than re-binding on every render
$('j-open-rows').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  const id = b.dataset.id;
  if(b.classList.contains('jclose'))       jStartClose(id);
  else if(b.classList.contains('jconfirm'))     jConfirmClose(id);
  else if(b.classList.contains('jcancelclose')) jCancelClose();
  else if(b.classList.contains('jdel')){ jDelete(id); renderJournal(); }
});
$('j-closed-rows').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  const id = b.dataset.id;
  if(b.classList.contains('jmore')){
    const det = $('jd-'+id);
    if(det){
      det.hidden = !det.hidden;
      b.setAttribute('aria-expanded', String(!det.hidden));
      b.textContent = det.hidden ? 'Details' : 'Hide';
    }
    return;   // a re-render here would collapse the panel that was just opened
  }
  if(b.classList.contains('jreopen')){ jReopen(id); renderJournal(); }
  else if(b.classList.contains('jdel')){ jDelete(id); renderJournal(); }
});
$('j-account').value = jCfg.account;
$('j-riskpct').value = jCfg.riskPct;
$('j-riskusd').value = jCfg.riskUsd;
jRenderSizeWork();
renderJournal();
$('nav-logan').onclick = ()=> setView('logan');
$('lg-offbtn').onclick = ()=>{
  const b=$('lg-settings'); b.hidden=false;
  $({anthropic:'lg-key', gemini:'lg-gkey', openrouter:'lg-orkey'}[lgCfg.provider] || 'lg-key').focus();
};
document.querySelectorAll('#lg-provider button').forEach(b=>{
  b.onclick = ()=> lgShowProviderFields(b.dataset.provider);
});
$('lg-send').onclick = ()=>{ const t=$('lg-text'); lgSend(t.value); t.value=''; t.style.height='auto'; };
$('lg-text').addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    const t=$('lg-text'); lgSend(t.value); t.value=''; t.style.height='auto';
  }
});
$('lg-text').addEventListener('input', e=>{
  e.target.style.height='auto';
  e.target.style.height = Math.min(130, e.target.scrollHeight)+'px';
});
$('lg-clear').onclick = ()=>{ lgForgetChat(); lgRender(); };
$('lg-setup').onclick = ()=>{ const b=$('lg-settings'); b.hidden = !b.hidden; };
$('lg-save').onclick = ()=>{
  const chosen = document.querySelector('#lg-provider button[aria-pressed="true"]');
  const wasProvider = lgCfg.provider;
  lgCfg.provider = (chosen && chosen.dataset.provider) || 'anthropic';
  lgCfg.anthropicKey = $('lg-key').value.trim();
  lgCfg.anthropicModel = $('lg-model').value.trim();
  lgCfg.geminiKey = $('lg-gkey').value.trim();
  lgCfg.geminiModel = $('lg-gmodel').value.trim();
  lgCfg.openrouterKey = $('lg-orkey').value.trim();
  lgCfg.openrouterModel = $('lg-ormodel').value.trim();
  const ok = lgSaveCfg();
  /*  The two providers' transcripts are not interchangeable, so switching
      backends drops the replayable context while leaving the visible chat
      alone. Logan starts fresh; the conversation stays on screen.          */
  if(lgCfg.provider !== wasProvider){ Object.values(AGENTS).forEach(ag=>{ ag.api = []; agSaveChat(ag); }); }
  $('lg-keynote').textContent = ok
    ? 'Saved in this browser. Sent only to '+lgProviderHost()+'.'
    : 'This preview cannot save settings, so the key lasts only for this session.';
  $('lg-settings').hidden = true;
  // the empty-state copy differs online vs offline, and both agents show it
  Object.values(AGENTS).forEach(ag=>{ agSetMode(ag); agRender(ag); });
};
$('lg-brief').onclick = async ()=>{
  const text = briefing();
  try{
    await navigator.clipboard.writeText(text);
    $('lg-brief').textContent = 'Copied';
  }catch(e){
    // clipboard blocked (common on file://) — put it in the log to copy by hand
    lgPush('assistant', 'Clipboard is blocked here, so here is the briefing to copy:\n\n'+text);
    $('lg-brief').textContent = 'In chat';
  }
  setTimeout(()=>{ $('lg-brief').textContent = 'Copy briefing'; }, 1800);
};
/* ---------- saved chats ----------
   One delegated listener per agent covers both switching and deleting, and the
   delete × sits inside the session button, so the guard on it has to come first
   or clicking × would also switch to the session being removed.             */
function wireSessions(ag, newBtnId){
  $(newBtnId).onclick = ()=> agNewSession(ag);
  $(ag.dom.sessions).addEventListener('click', e=>{
    const del = e.target.closest('[data-del]');
    if(del){ e.stopPropagation(); agDeleteSession(ag, del.dataset.del); return; }
    const b = e.target.closest('[data-sess]');
    if(b) agSwitchSession(ag, b.dataset.sess);
  });
}

/* ---------- Paul ---------- */
$('nav-paul').onclick = ()=> setView('paul');
$('nav-anomhist').onclick = ()=> setView('anomhist');
$('pl-send').onclick = ()=>{ const t=$('pl-text'); plSend(t.value); t.value=''; t.style.height='auto'; };
$('pl-text').addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    const t=$('pl-text'); plSend(t.value); t.value=''; t.style.height='auto';
  }
});
$('pl-text').addEventListener('input', e=>{
  e.target.style.height='auto';
  e.target.style.height = Math.min(130, e.target.scrollHeight)+'px';
});
$('pl-clear').onclick = ()=>{ plForgetChat(); plRender(); };
$('pl-setup').onclick = ()=>{ setView('logan'); $('lg-settings').hidden = false; };

/* ---------- Maria ---------- */
$('nav-maria').onclick = ()=> setView('maria');
$('mr-send').onclick = ()=>{ const t=$('mr-text'); mrSend(t.value); t.value=''; t.style.height='auto'; };
$('mr-text').addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    const t=$('mr-text'); mrSend(t.value); t.value=''; t.style.height='auto';
  }
});
$('mr-text').addEventListener('input', e=>{
  e.target.style.height='auto';
  e.target.style.height = Math.min(130, e.target.scrollHeight)+'px';
});
$('mr-clear').onclick = ()=>{ mrForgetChat(); mrRender(); };
// both agents share one Connection panel, which lives in Logan's view
$('mr-setup').onclick = ()=>{ setView('logan'); $('lg-settings').hidden = false; };

$('nav-terminal').onclick = ()=> setView('terminal');
$('nav-watch').onclick    = ()=> setView('watch');

/* ---------- cloud ---------- */
$('nav-cloud').onclick = ()=> setView('cloud');
$('cl-saveconfig').onclick = ()=>{
  const note = $('cl-confignote');
  try{
    cloudCfg.fb = cloudParseConfig($('cl-config').value);
    cloudSaveCfg();
    note.textContent = 'Saved. Sign in below — the first sign-in on a machine pulls everything down.';
    cloudRender();
  }catch(e){
    note.textContent = 'Could not read that: '+e.message+
      '. Paste the whole firebaseConfig block, braces included.';
  }
};
async function clAuth(makeAccount){
  const note = $('cl-last');
  const email = $('cl-email').value.trim(), pass = $('cl-pass').value;
  if(!cloudConfigured()){ note.textContent = 'Connect a Firebase project first.'; return; }
  if(!email || !pass){ note.textContent = 'Email and password are both needed.'; return; }
  note.textContent = makeAccount ? 'Creating account…' : 'Signing in…';
  try{
    await cloudSignIn(email, pass, makeAccount);
    $('cl-pass').value = '';
    cloudRender();
    note.textContent = 'Signed in. Syncing…';
    await cloudSyncAndRefresh();
    cloudRender();
  }catch(e){
    note.textContent = (makeAccount ? 'Could not create that account: ' : 'Could not sign in: ')+e.message;
    cloudRender();
  }
}
$('cl-signin').onclick = ()=> clAuth(false);
$('cl-signup').onclick = ()=> clAuth(true);
$('cl-signout').onclick = async ()=>{
  await cloudSignOut();
  cloudRender();
  $('cl-last').textContent = 'Signed out. This machine keeps its own copy of everything.';
};
$('cl-sync').onclick = ()=>{
  if(!cloudOn()){ $('cl-last').textContent = 'Sign in first.'; return; }
  cloudSyncAndRefresh();
};
$('cl-secrets').onchange = e=>{
  cloudCfg.syncSecrets = e.target.checked;
  cloudSaveCfg();
  cloudRender();
};

const wInput = $('wsearch');
wInput.addEventListener('focus', ()=> loadUniverse());
wInput.addEventListener('input', async ()=>{
  renderWSugg(searchSymbols(wInput.value));
  await loadUniverse();
  if(document.activeElement===wInput) renderWSugg(searchSymbols(wInput.value));
});
wInput.addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    const hits = searchSymbols(e.target.value);
    addWatch(hits.length ? hits[0].sym : e.target.value);
  }
  if(e.key==='Escape') $('wsugg').hidden = true;
});
wInput.addEventListener('blur', ()=> setTimeout(()=>{ $('wsugg').hidden = true; }, 120));

$('refresh').onclick = load;
$('m-perp').onclick = ()=> switchMarket('linear');
$('m-spot').onclick = ()=> switchMarket('spot');
$('why').onchange = redrawWhy;
$('pickall').onclick = ()=>{ shown = shown.length===5 ? ['1D'] : TFS.map(t=>t.key); buildPicker(); buildCharts(); };
const symInput = $('symsearch');
symInput.addEventListener('focus', async ()=>{
  await loadUniverse();
  if(symInput.value.trim()) renderSuggestions(searchSymbols(symInput.value));
});
symInput.addEventListener('input', async ()=>{
  renderSuggestions(searchSymbols(symInput.value));
  await loadUniverse();
  if(document.activeElement===symInput) renderSuggestions(searchSymbols(symInput.value));
});
symInput.addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    const hits = searchSymbols(e.target.value);
    switchSymbol(hits.length ? hits[0].sym : e.target.value);
    $('symsugg').hidden = true;
  }
  if(e.key==='Escape') $('symsugg').hidden = true;
});
symInput.addEventListener('blur', ()=> setTimeout(()=>{ $('symsugg').hidden = true; }, 120));

let rz; addEventListener('resize', ()=>{
  if(LWC()) return;                      // autoSize handles it
  clearTimeout(rz); rz = setTimeout(buildCharts,150);
});
nvLoadCoins();
watch = store.read();
updateWatchCount();
renderTrackBtn();
lgInit();
idleInit();
wireSessions(LOGAN, 'lg-newchat');
wireSessions(MARIA, 'mr-newchat');
wireSessions(PAUL,  'pl-newchat');
cloudInit();
buildScanControls();
buildHistHeads();
buildAlertControls();
restartAlertTimer();
if(alertCfg.on) alertTick();
buildScanControls();
buildPicker();
buildSymbolPicker();
setInterval(()=>{ if(view==='watch') scanWatch(); }, 15000);
load();
refreshTicker();
ensureBtc(true);
setInterval(()=>ensureBtc(), 30000);
setInterval(load, POLL);
setInterval(refreshTicker, 5000);
setInterval(tick, 1000);

$('nv-run').onclick  = newsScan;
$('nv-stop').onclick = ()=>{ newsAbort = true; };
$('nav-news').onclick = ()=> setView('news');

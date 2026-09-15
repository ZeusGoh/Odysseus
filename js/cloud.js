/* cloud.js — Optional cloud sync. Signs you in and mirrors the app's saved state
   to your own Firebase project, so the same journal, watchlist, alerts and
   Logan memory follow you to any machine.

   Everything here is additive. With no Firebase config saved — which is the
   state the app ships in — nothing in this file reaches the network, the
   Firebase SDK is never downloaded, and every read and write behaves exactly
   as it did before: localStorage, on this machine, and nowhere else. The
   local-only app is not a degraded mode, it is the default one.

   part of Odysseus */

/* ---------- what syncs ----------
   Caches are deliberately absent. vl.why.v1 and vl.coins.v2 are regenerated
   from the network on demand, are the two largest blobs the app holds, and
   carry nothing a person would miss. Syncing them would burn quota to move
   data that rebuilds itself in seconds.

   `secret` marks the two keys that hold credentials — the Telegram bot token
   and the Claude/Gemini API keys. They are held back unless you ask for them,
   because "my data is on a server now" is a different promise for a trade
   journal than it is for a key that can spend money.                        */
const CLOUD_KEYS = [
  {k:'vl.watchlist.v1',   label:'Watchlist',           secret:false},
  {k:'vl.journal.v1',     label:'Journal trades',      secret:false},
  {k:'vl.journal.cfg.v1', label:'Journal settings',    secret:false},
  {k:'vl.logan.chat.v1',  label:"Logan's memory",      secret:false},
  {k:'vl.maria.chat.v1',  label:"Maria's memory",      secret:false},
  {k:'vl.paul.chat.v1',   label:"Paul's memory",       secret:false},
  {k:'vl.news.v1',        label:'News settings',       secret:false},
  /*  The anomaly log syncs for the same reason the journal does: it is a record being built up
      over weeks toward a sample worth reading, and a record that only exists on whichever
      machine happened to run the scan is a record that never reaches 30 flags. It is the
      largest non-cache key here — a full 1000 entries is roughly 440KB — which is comfortable
      only because each key gets its own document rather than sharing one 1MB ceiling.       */
  {k:'vl.news.anomalies.v1', label:'Anomaly log',      secret:false},
  {k:'vl.fired.v1',       label:'Already-fired alerts',secret:false},
  {k:'vl.alerts.v1',      label:'Alert settings',      secret:true },
  {k:'vl.logan.v1',       label:'Logan API keys',      secret:true }
];

const CLOUD_KEY      = 'vl.cloud.v1';        // firebase config + preferences
const CLOUD_META_KEY = 'vl.cloud.meta.v1';   // per-key local/synced timestamps
const FB_SDK = '12.19.0';                    // pinned; an SDK that moves under you is a bug you cannot reproduce

/*  The Firebase project this app ships pointed at.

    This is not a secret and is not treated as one — Google publishes these in
    the console for you to paste into client code, and every web app that uses
    Firebase ships one. It identifies the project; it grants nothing. What
    actually guards the data is the Firestore rule that a document under
    users/<uid> is readable and writable only by the signed-in account whose
    uid matches, plus the password on that account.

    Baked in so a new machine needs a sign-in and nothing else. Anything saved
    in the Cloud panel overrides it, for pointing at a different project.     */
const FB_DEFAULT = {
  apiKey: 'AIzaSyAdFFJy2rG2mfc2dkdCU8KNjpvfz4t2UK4',
  authDomain: 'odysseus-6ad9d.firebaseapp.com',
  projectId: 'odysseus-6ad9d',
  storageBucket: 'odysseus-6ad9d.firebasestorage.app',
  messagingSenderId: '807447206943',
  appId: '1:807447206943:web:09c3b6acf87ae97a6e092a'
};

const cloudCfg = (()=>{
  let c;
  try{ c = JSON.parse(localStorage.getItem(CLOUD_KEY)||'{}'); }catch(e){ c = {}; }
  if(!c.fb) c.fb = FB_DEFAULT;
  return c;
})();

/*  local[key]  — when this browser last wrote that key
    synced[key] — the remote timestamp this browser last reconciled against
    The pair is what makes "changed since we last agreed" answerable on both
    sides without a server clock or a diff.                                  */
const cloudMeta = (()=>{
  let m;
  try{ m = JSON.parse(localStorage.getItem(CLOUD_META_KEY)||'{}'); }catch(e){ m = {}; }
  if(!m.local)  m.local  = {};
  if(!m.synced) m.synced = {};
  return m;
})();

let fb = null;            // the loaded SDK surface, once someone actually needs it
let cloudUser = null;     // the signed-in firebase user, or null
let cloudBusy = false;
let cloudPushTimer = 0;
let cloudNote = '';       // last thing worth telling the user

function cloudSaveCfg(){
  try{ localStorage.setItem(CLOUD_KEY, JSON.stringify(cloudCfg)); return true; }catch(e){ return false; }
}
function cloudSaveMeta(){
  try{ localStorage.setItem(CLOUD_META_KEY, JSON.stringify(cloudMeta)); }catch(e){}
}

function cloudConfigured(){
  return !!(cloudCfg.fb && cloudCfg.fb.apiKey && cloudCfg.fb.projectId);
}
function cloudOn(){ return cloudConfigured() && !!cloudUser; }

// keys in play right now — the secret two only when explicitly opted in
function cloudActiveKeys(){
  return CLOUD_KEYS.filter(e => !e.secret || cloudCfg.syncSecrets);
}

/* ---------- the write funnel ----------
   Every place the app persists state calls this instead of localStorage
   directly, so a local edit is stamped the moment it happens. Without that
   stamp there is no way to tell "this machine changed it" from "the other
   machine changed it", and last-write-wins degenerates into last-to-sync-wins.

   It returns the same true/false the old inline try/catch did, so callers that
   report "this preview cannot save" keep working unchanged.                 */
function vlPut(key, json){
  let ok = true;
  try{ localStorage.setItem(key, json); }catch(e){ ok = false; }
  cloudMeta.local[key] = Date.now();
  cloudSaveMeta();
  cloudSchedulePush();
  return ok;
}

/* ---------- loading the SDK ----------
   Pulled in on demand with a dynamic import rather than a script tag, which
   keeps index.html free of Firebase entirely and means a local-only user never
   downloads a byte of it. Classic scripts can await an ES module this way; the
   modular SDK is the only build Google documents now.                       */
async function cloudLoadSdk(){
  if(fb) return fb;
  const base = 'https://www.gstatic.com/firebasejs/'+FB_SDK+'/';
  const [app, auth, store] = await Promise.all([
    import(base+'firebase-app.js'),
    import(base+'firebase-auth.js'),
    import(base+'firebase-firestore.js')
  ]);
  fb = {app, auth, store};
  return fb;
}

async function cloudInitApp(){
  const sdk = await cloudLoadSdk();
  if(!fb.instance){
    fb.instance = sdk.app.initializeApp(cloudCfg.fb);
    fb.authRef  = sdk.auth.getAuth(fb.instance);
    fb.dbRef    = sdk.store.getFirestore(fb.instance);
    // survive a reload without asking for the password again
    try{ await sdk.auth.setPersistence(fb.authRef, sdk.auth.browserLocalPersistence); }catch(e){}
  }
  return fb;
}

/* ---------- auth ---------- */
async function cloudSignIn(email, password, makeAccount){
  const sdk = await cloudInitApp();
  const fn = makeAccount ? sdk.auth.createUserWithEmailAndPassword
                         : sdk.auth.signInWithEmailAndPassword;
  const cred = await fn(fb.authRef, email, password);
  cloudUser = cred.user;
  cloudCfg.email = email;             // remembered so the field is pre-filled, never the password
  cloudSaveCfg();
  return cloudUser;
}

async function cloudSignOut(){
  if(fb && fb.authRef){ try{ await fb.authRef.signOut(); }catch(e){} }
  cloudUser = null;
}

/*  Restores an existing session on load. Resolves either way — a failure here
    means "running local", never a broken app.                               */
async function cloudResume(){
  if(!cloudConfigured()) return null;
  try{
    const sdk = await cloudInitApp();
    cloudUser = await new Promise(res=>{
      const stop = sdk.auth.onAuthStateChanged(fb.authRef, u=>{ stop(); res(u||null); });
    });
    return cloudUser;
  }catch(e){ cloudNote = 'Cloud unavailable: '+e.message; return null; }
}

/* ---------- the sync itself ----------
   One Firestore document per key under users/<uid>/state, rather than one
   document holding everything. A single document would be rewritten in full on
   every change, would share one 1MB ceiling across the journal and Logan's
   transcript, and would turn any two concurrent edits into a whole-state
   conflict instead of a one-key one.                                        */
function cloudDocRef(key){
  return fb.store.doc(fb.dbRef, 'users', cloudUser.uid, 'state', key);
}

/*  A local value about to be displaced by a different remote one is copied
    aside first. This only bites on the first sync of a machine that already
    had its own data, but that is exactly the moment a person would lose a
    journal they cared about, so it is never silently overwritten.           */
function cloudBackup(key, value){
  try{ localStorage.setItem('vl.cloud.backup.'+key, value); }catch(e){}
}

/*  The whole of the sync's judgement, with nothing around it — no network, no
    storage, no clock. Kept separate because this is the part that can quietly
    lose someone's journal, and a pure function is the only kind you can
    actually pin down in a test.

    local     — the value on this machine, or null if absent
    localTs   — when this machine last wrote it
    syncedTs  — the remote timestamp we last agreed with
    remote    — {value, at} from the server, or null if the doc is absent    */
function cloudDecide(local, localTs, syncedTs, remote){
  if(!remote) return local == null ? 'skip' : 'push';   // nothing up there yet
  if(remote.value === local) return 'same';

  const localChanged  = localTs > syncedTs;
  const remoteChanged = remote.at !== syncedTs;

  if(!localChanged)  return 'pull';   // includes a fresh machine, where nothing local is newer
  if(!remoteChanged) return 'push';   // only this side moved
  return (localTs >= remote.at) ? 'push' : 'pull';      // both moved — the later edit stands
}

async function cloudSyncKey(entry){
  const key = entry.k;
  const local = localStorage.getItem(key);

  let remote = null;
  const snap = await fb.store.getDoc(cloudDocRef(key));
  if(snap.exists()) remote = snap.data();

  const verdict = cloudDecide(local, cloudMeta.local[key]||0, cloudMeta.synced[key]||0, remote);

  if(verdict === 'same'){ if(remote) cloudMeta.synced[key] = remote.at; return 'same'; }
  if(verdict === 'skip') return 'skip';

  if(verdict === 'push'){
    const at = Date.now();
    await fb.store.setDoc(cloudDocRef(key), {value: local, at, key});
    cloudMeta.local[key]  = at;   // the value on disk and the value on the server are now the same one
    cloudMeta.synced[key] = at;
    return 'pushed';
  }

  if(local != null) cloudBackup(key, local);
  try{ localStorage.setItem(key, remote.value); }catch(e){ return 'blocked'; }
  cloudMeta.local[key]  = remote.at;
  cloudMeta.synced[key] = remote.at;
  return 'pulled';
}

async function cloudSync(){
  if(!cloudOn() || cloudBusy) return null;
  cloudBusy = true; cloudRender();
  const tally = {pushed:0, pulled:0, same:0, skip:0, blocked:0};
  try{
    for(const entry of cloudActiveKeys()){
      const r = await cloudSyncKey(entry);
      tally[r] = (tally[r]||0) + 1;
    }
    cloudCfg.lastSync = Date.now();
    cloudSaveCfg(); cloudSaveMeta();
    cloudNote = '';
  }catch(e){
    cloudNote = 'Sync failed: '+e.message;
  }finally{
    cloudBusy = false; cloudRender();
  }
  return tally;
}

/*  A pull replaces values underneath code that already read them into memory,
    so the only honest way to show the result is to start the page over. Done
    only when something actually came down.                                  */
async function cloudSyncAndRefresh(){
  const t = await cloudSync();
  if(t && t.pulled > 0) location.reload();
  return t;
}

// local edits are bursty — a journal save is three writes in a row — so the
// push is coalesced rather than fired per keystroke
function cloudSchedulePush(){
  if(!cloudOn()) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(()=>{ cloudSync(); }, 4000);
}

/* ---------- UI ---------- */
function cloudStatusText(){
  if(!cloudConfigured()) return 'local only';
  if(cloudBusy)          return 'syncing…';
  if(!cloudUser)         return 'signed out';
  return 'synced';
}

function cloudRender(){
  const badge = $('cl-mode');
  if(badge){
    badge.textContent = cloudStatusText();
    badge.classList.toggle('api', cloudOn());
  }
  const dot = $('cloud-dot');
  if(dot) dot.textContent = cloudOn() ? 'on' : cloudConfigured() ? 'off' : 'local';

  const who = $('cl-who');
  if(who){
    who.textContent = cloudUser
      ? 'Signed in as '+(cloudUser.email||cloudUser.uid)
      : (cloudConfigured() ? 'Not signed in.' : 'No Firebase project connected yet.');
  }

  const signedIn = !!cloudUser;
  const setHidden = (id, v)=>{ const el = $(id); if(el) el.hidden = v; };
  setHidden('cl-authrow',  signedIn);
  setHidden('cl-signedrow', !signedIn);

  const last = $('cl-last');
  if(last){
    last.textContent = cloudNote ? cloudNote
      : cloudCfg.lastSync ? 'Last synced '+new Date(cloudCfg.lastSync).toLocaleString()
      : cloudConfigured() ? 'Not synced yet.' : '';
  }

  const list = $('cl-keys');
  if(list){
    list.innerHTML = '';
    CLOUD_KEYS.forEach(e=>{
      const on = !e.secret || cloudCfg.syncSecrets;
      const raw = localStorage.getItem(e.k);
      const li = document.createElement('li');
      li.className = on ? '' : 'off';
      const size = raw ? (raw.length > 1024 ? (raw.length/1024).toFixed(1)+' KB' : raw.length+' B') : 'empty';
      li.textContent = e.label + ' — ' + (on ? size : 'not synced');
      list.appendChild(li);
    });
  }

  const sec = $('cl-secrets');
  if(sec) sec.checked = !!cloudCfg.syncSecrets;
}

function cloudInit(){
  const box = $('cl-config');
  if(box && cloudCfg.fb) box.value = JSON.stringify(cloudCfg.fb, null, 2);
  const em = $('cl-email');
  if(em) em.value = cloudCfg.email || '';
  const note = $('cl-confignote');
  if(note) note.textContent = (cloudCfg.fb === FB_DEFAULT)
    ? 'Already pointed at the odysseus project — nothing to do here. Sign in above. '+
      'Only change this to use a different Firebase project.'
    : 'Using a config saved in this browser rather than the built-in one.';
  cloudRender();

  /*  Now that a project ships with the app, "configured" is true for everyone,
      so it can no longer be the thing that decides whether to touch the
      network. A signed-out machine has no session to restore and therefore no
      reason to fetch the SDK at all — it stays exactly as offline as it was
      before any of this existed, until someone signs in.                    */
  if(!cloudConfigured() || !cloudHasSession()) return;
  cloudResume().then(u=>{
    cloudRender();
    if(u) cloudSyncAndRefresh();
  });
}

/*  Firebase Auth parks its persisted session in localStorage under a key built
    from the api key. Reading it directly is the only way to ask "is anyone
    signed in here?" without first downloading the SDK that would answer it.  */
function cloudHasSession(){
  try{
    const key = cloudCfg.fb && cloudCfg.fb.apiKey;
    if(key && localStorage.getItem('firebase:authUser:'+key+':[DEFAULT]')) return true;
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.indexOf('firebase:authUser:') === 0) return true;
    }
  }catch(e){}
  return false;
}

/*  Firebase hands you a JS object literal in the console, not JSON, so the
    paste is almost never valid JSON. Rather than making the user hand-edit
    quotes, the braces are pulled out and the keys quoted.                   */
function cloudParseConfig(text){
  const t = (text||'').trim();
  if(!t) throw new Error('nothing pasted');
  const braced = t.slice(t.indexOf('{'), t.lastIndexOf('}')+1);
  if(!braced) throw new Error('could not find the { … } block');
  try{ return JSON.parse(braced); }catch(e){}
  const quoted = braced
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')   // bare keys -> "keys"
    .replace(/'/g, '"')                                        // single -> double quotes
    .replace(/,(\s*})/g, '$1');                                // trailing comma
  return JSON.parse(quoted);
}

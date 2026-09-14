/* storage.js — Persistence. localStorage with an in-memory fallback for contexts that block it.
   part of Odysseus */

/* ---------- persistence ----------
   Written to localStorage so the watchlist survives a reload. In sandboxed
   previews storage can throw, so every call degrades to session-only memory
   rather than taking the app down.                                          */
const KEY = 'vl.watchlist.v1';
let memoryFallback = null;
const store = {
  read(){
    try{
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    }catch(e){ return memoryFallback || []; }
  },
  write(list){
    memoryFallback = list;
    try{ localStorage.setItem(KEY, JSON.stringify(list)); return true; }
    catch(e){ return false; }
  },
  durable(){
    try{ localStorage.setItem(KEY+'.probe','1'); localStorage.removeItem(KEY+'.probe'); return true; }
    catch(e){ return false; }
  }
};

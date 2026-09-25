/* ui-fold.js — every panel folds. A small chevron on each panel's header
   hides everything under it; the choice is remembered per panel, in this
   browser, so a page you have trimmed stays trimmed next time.

   Nothing is unloaded — a folded panel keeps rendering behind its header,
   so unfolding it is instant and nothing that reads the DOM breaks. The
   key is the panel's id where it has one, otherwise the view it sits in
   plus its title, so two panels called "Open" on different pages fold
   independently.
   part of Odysseus */

const FOLD_KEY = 'vl.folds.v1';

function foldLoad() {
  try { const j = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}'); return j && typeof j === 'object' ? j : {}; }
  catch (e) { return {}; }
}
function foldSave(map) { try { localStorage.setItem(FOLD_KEY, JSON.stringify(map)); } catch (e) { /* private mode */ } }

function foldKeyOf(mod) {
  if (mod.id) return mod.id;
  const h = mod.querySelector(':scope > header h2');
  const owner = mod.closest('[id$="view"]');
  return (owner ? owner.id : 'page') + ':' + (h ? h.textContent.trim().toLowerCase().replace(/\s+/g, '-') : 'panel');
}

function foldApply(mod, on) {
  mod.classList.toggle('folded', !!on);
  const b = mod.querySelector(':scope > header .fold');
  if (b) { b.setAttribute('aria-expanded', !on); b.title = on ? 'Show this panel' : 'Hide this panel'; }
}

/*  Adds the chevron to every panel with a header, once. Safe to call
    again after markup is added — panels already fitted are skipped.     */
function foldInit(root) {
  const map = foldLoad();
  (root || document).querySelectorAll('section.mod').forEach(mod => {
    const head = mod.querySelector(':scope > header');
    if (!head || head.querySelector('.fold')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fold'; b.setAttribute('aria-label', 'Hide this panel');
    b.innerHTML = '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    head.appendChild(b);
    const key = foldKeyOf(mod);
    // a panel can ask to start folded (data-fold-default); the user's choice, once made, wins
    foldApply(mod, map[key] == null ? mod.hasAttribute('data-fold-default') : !!map[key]);
    b.addEventListener('click', e => {
      e.stopPropagation();
      const now = !mod.classList.contains('folded');
      foldApply(mod, now);
      const m = foldLoad();
      m[key] = now ? 1 : 0;
      foldSave(m);
      mod.dispatchEvent(new CustomEvent('fold', { detail: { folded: now } }));
    });
  });
}

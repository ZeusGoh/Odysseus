#!/usr/bin/env node
/* watch.js — the unattended run.

   Wakes up on a schedule, works out whether anything on the watchlist is worth
   thinking about, and only then spends a model call on it.

   That gate is the whole design. Running two analysts over fifteen coins every
   hour is ~720 subagent runs a day to report, almost every time, that nothing
   has changed — which is both expensive and useless, and worse, it trains you
   to ignore the output. So each run does the cheap part first: the engine
   recomputes the board and every coin's indicator read using nothing but the
   app's own code and free exchange data, and a coin is handed to the analysts
   only when something actually happened to it.

   Every trigger carries a stable key — the bar the cross printed on, the hour
   the move landed in — so the same event is read once and not re-read every
   hour it stays fresh.

     node mcp/watch.js                 one pass over the watchlist
     node mcp/watch.js --dry-run       decide and report; spend nothing
     node mcp/watch.js --all           skip the gate, read every coin
     node mcp/watch.js --symbols A,B   just these
     node mcp/watch.js --scope board   every liquid book on the exchange
     node mcp/watch.js --max-reads 8   the model-call budget for one pass
     node mcp/watch.js --no-publish    write reports, do not push to the app

   Scanning is free, reading is not, so a wide scope needs a budget: every
   flagged coin is ranked by how much happened to it, the top few are read,
   and the rest are named in the log and in verdicts/.last-pass.json so the
   app can show them. Nothing skipped is remembered, so it gets first go next
   hour if it is still fresh.

   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { Engine } = require('./engine.js');
const { settleAll } = require('./score.js');
const { postmortemPass, POSTMORTEM_MAX_PER_PASS } = require('./postmortem.js');

const ROOT = path.join(__dirname, '..');
const VERDICTS = path.join(ROOT, 'verdicts');
const STATE_FILE = path.join(VERDICTS, '.watch-state.json');
const LOG_FILE = path.join(VERDICTS, 'watch.log');

/* ==WATCH_START== */
/*  What counts as "something happened". Every threshold is here, in one place,
    because these are the numbers that decide what you get woken up about.   */
const WATCH_CFG = {
  freshWithin: 2,        // bars — a cross older than this is not news any more
  minFrameWeight: 2,     // 4H and above; a 1H cross alone is not worth a read
  gradeFloor: ['playable', 'strong'],
  minSignals: 20,        // a graded setup on a thinner sample is a lean, not a trigger
  specMovePct: 8,        // a coin-specific move this big is its own event
  volMultiple: 4,        // an hour on this much volume is a real print
  oiPct: 10,             // open interest moving this much is positioning, not drift
  stateDays: 7,          // how long a seen trigger stays remembered
  maxReads: 5,           // model-call budget per pass; 0 means no budget
  postmortems: 0,        // news-analyst post-mortems per pass on settled misses; 0 = off (--postmortem turns it on)
  /*  Standing reads: coins the analysts keep reading on a clock whether or
      not anything crossed the gate, so the app's dedicated Bitcoin page
      always has a read no older than this. Outside the budget — a standing
      read never costs a flagged coin its turn. watchlist.json's `always`
      overrides the list; the interval is one 4H bar.                    */
  always: ['BTC'],
  alwaysEveryMin: 240,
};

const FRAME_WEIGHT = { '1M': 5, '1W': 4, '1D': 3, '4H': 2, '1H': 1 };

/*  Returns every reason this coin is worth a read, each with a key that
    identifies the EVENT rather than the moment of looking. Pure: no clock, no
    disk, no network — which is the only way to pin down the thing that decides
    how much this costs.                                                      */
function watchTriggersFor(stoch, news, cfg) {
  const c = Object.assign({}, WATCH_CFG, cfg || {});
  const out = [];
  const sym = (stoch && stoch.symbol) || (news && news.symbol);
  if (!sym) return out;

  /* ---- the indicator side ---- */
  const frames = (stoch && stoch.frames) || {};
  for (const [key, f] of Object.entries(frames)) {
    const weight = FRAME_WEIGHT[key] || 0;
    if (weight < c.minFrameWeight) continue;
    const x = f.cross;
    if (!x || (x.type !== 'bull' && x.type !== 'bear' &&
               x.type !== 'potential-bull' && x.type !== 'potential-bear')) continue;

    const settled = x.type === 'bull' || x.type === 'bear';
    const fresh = settled ? (x.barsAgo != null && x.barsAgo <= c.freshWithin) : true;
    if (!fresh) continue;

    // an ungraded or losing setup is not worth two model calls
    const v = f.verdict || {};
    const graded = c.gradeFloor.includes(v.grade) &&
                   (v.signals == null || v.signals >= c.minSignals);
    if (!graded) continue;

    out.push({
      kind: 'cross',
      key: sym + '|cross|' + key + '|' + (x.barOpened || x.barsAgo) + '|' + x.type,
      why: key + ' ' + x.type + ' cross from ' + (x.zone || '?') + ' grades ' + v.grade +
           (v.hitRate ? ' (' + v.hitRate + ' of ' + v.signals + ')' : '') +
           (x.pending ? ', still on the live bar' : ''),
      weight,
    });
  }

  /* ---- the structural side ---- */
  if (news && news.move) {
    const m = news.move;
    const sharp = news.sharpestHour;
    const anchor = sharp ? sharp.at : news.window;

    if (m.classification === 'spec' && Math.abs(m.pct) >= c.specMovePct) {
      out.push({
        kind: 'move',
        key: sym + '|move|' + anchor,
        why: m.pct + '% over ' + news.window + ' is coin-specific — ' +
             m.excessPct + '% beyond a board that moved ' + m.boardMedianPct + '%',
        weight: 3,
      });
    }

    if (sharp && sharp.volumeMultiple != null && sharp.volumeMultiple >= c.volMultiple) {
      out.push({
        kind: 'volume',
        key: sym + '|volume|' + sharp.at,
        why: 'one hour did ' + sharp.pct + '% on ' + sharp.volumeMultiple + 'x normal volume',
        weight: 2,
      });
    }

    const p = news.positioning || {};
    const tag = p.flow && p.flow.tag;
    const oi = p.openInterestChangePct;
    if ((tag === 'Short squeeze' || tag === 'Long flush') &&
        (p.fundingCrowded === true || (oi != null && Math.abs(oi) >= c.oiPct))) {
      out.push({
        kind: 'positioning',
        key: sym + '|flow|' + tag + '|' + anchor,
        why: tag.toLowerCase() + ': open interest ' + (oi == null ? '?' : oi + '%') +
             (p.fundingCrowded ? ', funding crowded' : ''),
        weight: 3,
      });
    }
  }

  return out;
}

function watchFilterSeen(triggers, state) {
  const seen = (state && state.seen) || {};
  return (triggers || []).filter(t => !seen[t.key]);
}

function watchRemember(state, triggers, now) {
  const s = state && typeof state === 'object' ? state : {};
  s.seen = s.seen || {};
  for (const t of triggers || []) s.seen[t.key] = now;
  return s;
}

/*  A trigger key is only useful while the event it names is recent. Without
    this the file grows forever and an old key silently suppresses a genuinely
    new event that happens to reuse a timestamp.                              */
function watchPruneState(state, now, days) {
  const cutoff = now - (days == null ? WATCH_CFG.stateDays : days) * 864e5;
  const s = { seen: {} };
  for (const [k, at] of Object.entries((state && state.seen) || {}))
    if (at >= cutoff) s.seen[k] = at;
  return s;
}

// the line the log gets, and the line a person reads
function watchSummary(sym, triggers) {
  if (!triggers.length) return sym + ': nothing new';
  return sym + ': ' + triggers.map(t => t.why).join('; ');
}

/*  Most happened first. The score is the sum of the trigger weights — a
    graded weekly cross (4) plus a coin-specific move (3) outranks one hourly
    volume print (2) — so a budget spends itself on the coins with the most
    going on, and the rest wait their turn rather than being forgotten.   */
function watchRank(due) {
  return (due || [])
    .map(d => Object.assign({}, d, { score: (d.triggers || []).reduce((s, t) => s + (t.weight || 0), 0) }))
    .sort((a, b) => b.score - a.score ||
                    (b.triggers || []).length - (a.triggers || []).length ||
                    String(a.sym).localeCompare(String(b.sym)));
}

function watchBudget(ranked, maxReads) {
  const cap = maxReads == null ? WATCH_CFG.maxReads : maxReads;
  if (!cap || cap <= 0) return { read: ranked, skipped: [] };
  return { read: ranked.slice(0, cap), skipped: ranked.slice(cap) };
}

/*  Which standing coins are due this pass. `lastReadAt` maps a symbol to
    when its newest report was written (absent = never); a coin is due when
    that is older than the interval, and is skipped when the gate already
    put it in `toRead` this pass — the gated read IS the standing read then.
    The trigger key is bucketed by interval so watchRemember never
    suppresses the next one. Pure: the clock and the disk are arguments. */
function watchStanding(always, lastReadAt, toRead, now, everyMin) {
  const every = (everyMin == null ? WATCH_CFG.alwaysEveryMin : everyMin) * 60000;
  if (!(every > 0)) return [];
  const reading = new Set((toRead || []).map(d => d.sym));
  const seen = new Set();
  const out = [];
  for (const raw of always || []) {
    const sym = String(raw || '').trim().toUpperCase();
    if (!sym || seen.has(sym) || reading.has(sym)) continue;
    seen.add(sym);
    const at = lastReadAt && lastReadAt[sym];
    if (Number.isFinite(at) && now - at < every) continue;
    const hours = Math.round(every / 3600000 * 10) / 10;
    out.push({ sym, score: 0, standing: true, triggers: [{
      key: 'standing|' + sym + '|' + Math.floor(now / every),
      why: 'standing read: ' + (Number.isFinite(at) ? 'last read ' + Math.round((now - at) / 3600000) + 'h ago' : 'no read yet') +
           ', due every ' + hours + 'h',
      weight: 0,
    }] });
  }
  return out;
}
/* ==WATCH_END== */

/* ---------- plumbing ---------- */

function parseArgs(argv) {
  const out = { dryRun: false, all: false, symbols: null, publish: true, help: false, quiet: false,
                scope: null, maxReads: null, postmortems: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--no-publish') out.publish = false;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--symbols') out.symbols = argv[++i];
    else if (a.startsWith('--symbols=')) out.symbols = a.slice(10);
    else if (a === '--scope') out.scope = argv[++i];
    else if (a.startsWith('--scope=')) out.scope = a.slice(8);
    else if (a === '--max-reads') out.maxReads = Number(argv[++i]);
    else if (a.startsWith('--max-reads=')) out.maxReads = Number(a.slice(12));
    else if (a === '--postmortem') out.postmortems = POSTMORTEM_MAX_PER_PASS;
    else if (a.startsWith('--postmortem=')) out.postmortems = Number(a.slice(13));
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (out.scope && !['watchlist', 'app', 'board'].includes(out.scope))
    throw new Error('--scope must be watchlist, app or board, got "' + out.scope + '"');
  if (out.maxReads != null && !(Number.isFinite(out.maxReads) && out.maxReads >= 0))
    throw new Error('--max-reads must be a number, 0 for no budget');
  return out;
}

const LAST_PASS_FILE = path.join(VERDICTS, '.last-pass.json');
const LOCK_FILE = path.join(VERDICTS, '.watch-lock.json');
const LOCK_STALE_MS = 50 * 60000;   // a pass that old is a crashed one, not a running one

/*  One pass at a time. The 01:05 scheduled pass on 17 Sep started while the
    pass launched from the app at 00:49 was still reading — two sets of model
    calls, two writers of the same state. Task Scheduler is told not to
    overlap its own runs; this covers the app and a launcher too.        */
function watchLockState(existing, now, staleMs) {
  const stale = staleMs == null ? LOCK_STALE_MS : staleMs;
  if (!existing || !Number.isFinite(existing.at)) return { held: false };
  const age = now - existing.at;
  if (age < stale) return { held: true, ageMs: age, pid: existing.pid };
  return { held: false, stale: true, ageMs: age };
}

function takeLock() {
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) { /* none */ }
  const st = watchLockState(existing, Date.now());
  if (st.held) return st;
  try { fs.mkdirSync(VERDICTS, { recursive: true }); fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() })); }
  catch (e) { /* the lock is a courtesy, not the job */ }
  return { held: false, taken: true };
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* already gone */ }
}

function writeLastPass(info) {
  try {
    fs.mkdirSync(VERDICTS, { recursive: true });
    fs.writeFileSync(LAST_PASS_FILE, JSON.stringify(info, null, 2));
  } catch (e) { /* the file is a convenience for the app, not the job */ }
}

const USAGE = `
Odysseus unattended watch

  node mcp/watch.js                one pass: decide what changed, read only those
  node mcp/watch.js --dry-run      decide and report, spend no model calls
  node mcp/watch.js --all          skip the gate and read every coin
  node mcp/watch.js --symbols A,B  just these coins
  node mcp/watch.js --scope board  every liquid book on the exchange (or: app, watchlist)
  node mcp/watch.js --max-reads N  model-call budget per pass (default ${WATCH_CFG.maxReads}; 0 = none)
  standing reads: ${WATCH_CFG.always.join(', ')} every ${WATCH_CFG.alwaysEveryMin} min, gate or no gate, outside the budget (watchlist.json "always" overrides the list)
  node mcp/watch.js --no-publish   write reports locally, do not push to the app
  node mcp/watch.js --postmortem   also let the news analyst explain its settled misses (a model call each, ${POSTMORTEM_MAX_PER_PASS} per pass; --postmortem=N for another budget)
  node mcp/watch.js --quiet        log to the file only

The scope can also live in mcp/watchlist.json as {"scope": "board", "symbols": [...]}.

Publishing needs the app's Cloud credentials, from either:
  %USERPROFILE%\\.odysseus-cloud.json   {"email":"...","password":"..."}
  or ODYSSEUS_CLOUD_EMAIL / ODYSSEUS_CLOUD_PASSWORD
`.trim();

let quiet = false;
function log(line) {
  const stamped = new Date().toISOString() + '  ' + line;
  if (!quiet) process.stdout.write(stamped + '\n');
  try {
    fs.mkdirSync(VERDICTS, { recursive: true });
    fs.appendFileSync(LOG_FILE, stamped + '\n');
  } catch (e) { /* the log is a convenience, not the job */ }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { seen: {} }; }
}

function writeState(state) {
  try {
    fs.mkdirSync(VERDICTS, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { log('could not write the state file: ' + e.message); }
}

function cloudCreds() {
  if (process.env.ODYSSEUS_CLOUD_EMAIL && process.env.ODYSSEUS_CLOUD_PASSWORD)
    return { email: process.env.ODYSSEUS_CLOUD_EMAIL, password: process.env.ODYSSEUS_CLOUD_PASSWORD };
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const file = path.join(home, '.odysseus-cloud.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.email && j.password) return { email: j.email, password: j.password };
  } catch (e) { /* not there, or not readable */ }
  return null;
}

/*  The read's instructions, as a prompt. The interactive session expands
    "/read SOL" from .claude/commands/read.md; print mode does not reliably
    do the same — the DOGE and LINK reads of 16 Sep exited 0 in ten seconds
    having written nothing, because "/read DOGE" reached the model as plain
    text. So the command file is read here and sent whole, with $ARGUMENTS
    filled in, and nothing is left to expand. Pure, so it can be tested.  */
function watchPrompt(template, symbol) {
  const sym = String(symbol || '').trim().toUpperCase();
  let body = String(template || '');
  const m = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);   // frontmatter is for the command loader, not the model
  if (m) body = body.slice(m[0].length);
  return body.replace(/\$ARGUMENTS/g, sym).trim() + '\n';
}

function readTemplate() {
  for (const f of [
    path.join(ROOT, '.claude', 'commands', 'read.md'),
    path.join(ROOT, 'claude', 'claude-code-setup', 'read.md'),
  ]) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { /* next */ } }
  throw new Error('no read command file found (.claude/commands/read.md)');
}

/*  Did the read actually write a report for this coin since it started? A
    clean exit is not proof: Claude Code exits 0 after an API error, and a
    one-turn reply that never launched the analysts exits 0 too. The file is
    the only evidence that counts.                                          */
function watchReportSince(entries, symbol, sinceMs) {
  const sym = String(symbol || '').toLowerCase();
  return (entries || []).filter(e =>
    e && typeof e.name === 'string' && e.name.toLowerCase().startsWith(sym + '-') &&
    e.name.endsWith('.json') && e.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

function reportWrittenSince(symbol, sinceMs) {
  let names = [];
  try { names = fs.readdirSync(VERDICTS); } catch (e) { return null; }
  const entries = names.filter(n => !n.startsWith('.') && n !== 'latest.json' && n !== 'example.json')
    .map(n => { try { return { name: n, mtimeMs: fs.statSync(path.join(VERDICTS, n)).mtimeMs }; } catch (e) { return null; } });
  return watchReportSince(entries, symbol, sinceMs);
}

/*  Runs the read headlessly. Claude Code loads the project's .mcp.json and
    .claude/agents without a trust prompt in print mode, which is what makes
    this work from a scheduled task at all — but the tool grant is kept
    narrow rather than skipping permissions wholesale. The prompt goes in on
    stdin: it is a few kilobytes, and Windows caps a command line.         */
function runRead(symbol, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    let prompt;
    try { prompt = watchPrompt(o.template || readTemplate(), symbol); }
    catch (e) { return resolve({ ok: false, error: e.message }); }

    const args = [
      '-p',
      '--output-format', 'json',
      '--permission-mode', 'dontAsk',
      '--allowedTools', [
        'Task', 'Read', 'Write', 'WebSearch', 'WebFetch',
        'mcp__odysseus-stoch', 'mcp__odysseus-news', 'mcp__odysseus-crowd',
      ].join(','),
      '--max-turns', String(o.maxTurns || 40),
    ];

    /*  A scheduled task on Windows runs with a much smaller PATH than a login
        shell, so "claude" is often not found there even though it works fine
        in a terminal. ODYSSEUS_CLAUDE_BIN takes a full path.                */
    const bin = o.command || process.env.ODYSSEUS_CLAUDE_BIN || 'claude';
    const child = spawn(bin, args, {
      cwd: ROOT,
      env: process.env,
      shell: process.platform === 'win32',      // the Windows launcher needs it
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', () => { /* the child closed early; the close handler reports why */ });
    child.stdin.end(prompt);

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'timed out after ' + Math.round((o.timeoutMs || 600000) / 1000) + 's' });
    }, o.timeoutMs || 600000);

    child.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'could not start "' + bin + '": ' + e.message });
    });

    child.on('close', code => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (e) { /* plain text is fine too */ }
      const said = parsed && typeof parsed.result === 'string' ? parsed.result : out;
      if (code !== 0) {
        /*  --output-format json puts the failure on STDOUT, not stderr, so a
            stderr-only report reads as a silent exit 1 and says nothing about
            why. Both streams, or the diagnosis is guesswork.                */
        const detail = [err && err.trim(), out && out.trim()]
          .filter(Boolean).join(' | ').slice(0, 1500);
        return resolve({ ok: false, error: 'exited ' + code + (detail ? ': ' + detail : ' with no output on either stream') });
      }
      // exit 0 is not success: an API error is reported with exit 0 (a known quirk)
      if (parsed && parsed.is_error)
        return resolve({ ok: false, error: 'the model reported an error' +
          (parsed.api_error_status ? ' (' + parsed.api_error_status + ')' : '') + ': ' + String(said).slice(0, 400) });
      resolve({ ok: true, cost: parsed && parsed.total_cost_usd, turns: parsed && parsed.num_turns,
                result: said, durationMs: parsed && parsed.duration_ms });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE + '\n'); return; }
  quiet = args.quiet;

  const lock = takeLock();
  if (lock.held) {
    log('another pass is still running (started ' + Math.round(lock.ageMs / 60000) + ' min ago' +
        (lock.pid ? ', pid ' + lock.pid : '') + ') — skipping this one');
    return;
  }
  try { await pass(args); } finally { releaseLock(); }
}

async function pass(args) {
  const engine = new Engine({});
  await engine.ready();

  /*  Free: only fetches a symbol's price history when a checkpoint on one of
      its past reports is actually due. Keeps the two analysts' track records
      current without a separate schedule or any model cost.                */
  try {
    const settled = await settleAll(engine);
    if (settled.filled) log('settled ' + settled.filled + ' track-record checkpoint(s)');
    if (settled.restamped) log('re-timed ' + settled.restamped + ' report(s) to when the file was actually written' +
      (settled.retimed ? ' — ' + settled.retimed + ' record(s) cleared to settle again from the right time' : ''));
  } catch (e) { log('track-record settling failed: ' + e.message); }
  // the desk's own record, rebuilt after every settle so /read opens a current one
  try { require('./history.js').historyWriteDeskBrief(); }
  catch (e) { log('desk brief failed: ' + e.message); }
  /*  Optional, and a model call each: the news analyst goes back over its
      own settled misses and writes down what it missed. Off by default.  */
  const pm = args.postmortems != null ? args.postmortems : WATCH_CFG.postmortems;
  if (pm > 0) {
    try { await postmortemPass({ max: pm, dryRun: args.dryRun, log }); }
    catch (e) { log('post-mortems failed: ' + e.message); }
  }

  /* ---- what to scan ---- */
  const wl = engine.watchlist();
  const scope = args.symbols ? 'symbols' : (args.scope || wl.scope || 'watchlist');
  let symbols;
  if (args.symbols) {
    symbols = args.symbols.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  } else if (scope === 'board') {
    let board = [];
    try { board = await engine.boardSymbols(); }
    catch (e) { log('could not read the board (' + e.message + ') — scanning the listed coins only'); }
    symbols = [...new Set([...wl.symbols, ...board])];
  } else if (scope === 'app') {
    symbols = engine.appSymbols();
  } else {
    symbols = wl.symbols;
  }
  // an exclude list is absolute: a tokenised stock is not a coin, whatever its book
  const excluded = new Set(wl.exclude || []);
  const dropped = symbols.filter(s => excluded.has(s));
  symbols = symbols.filter(s => !excluded.has(s));
  if (dropped.length) log('excluded by watchlist.json: ' + dropped.join(', '));

  const cap = args.maxReads != null ? args.maxReads : WATCH_CFG.maxReads;
  const startedAt = Date.now();
  log('pass starting over ' + symbols.length + ' coin(s), scope ' + scope +
      (args.all ? ' (gate off)' : '') + (args.dryRun ? ' (dry run)' : '') +
      (cap ? ', budget ' + cap : ''));

  let state = watchPruneState(readState(), Date.now());
  const due = [];

  for (const sym of symbols) {
    try {
      const [stoch, news] = await Promise.all([
        engine.stochSnapshot(sym),
        engine.newsSnapshot(sym, { window: '24h', headlines: false }),
      ]);
      const all = watchTriggersFor(stoch, news);
      const fresh = args.all ? all : watchFilterSeen(all, state);
      if (args.all || fresh.length) due.push({ sym, triggers: fresh.length ? fresh : all });
      log('  ' + watchSummary(sym, fresh));
    } catch (e) {
      log('  ' + sym + ': could not read — ' + e.message);
    }
  }

  const ranked = watchRank(due);
  const { read: gated, skipped } = watchBudget(ranked, cap);

  /*  The standing reads ride along outside the budget. A single --symbols
      read is exactly that coin and nothing else, so they stay out of it. */
  const always = args.symbols ? [] : (wl.always || WATCH_CFG.always || []).filter(s => !excluded.has(s));
  const lastReadAt = {};
  for (const sym of always) {
    const w = reportWrittenSince(sym, 0);
    if (w) lastReadAt[sym] = w.mtimeMs;
  }
  const standing = watchStanding(always, lastReadAt, gated, Date.now());
  const toRead = gated.concat(standing);
  if (always.length)
    log('standing: ' + always.map(s => s + (standing.some(d => d.sym === s) ? ' due' :
        gated.some(d => d.sym === s) ? ' flagged anyway' : ' read ' + Math.round((Date.now() - lastReadAt[s]) / 3600000) + 'h ago')).join(', '));

  const flagged = ranked.map(d => ({ sym: d.sym, score: d.score, why: d.triggers.map(t => t.why).join('; ') }))
    .concat(standing.map(d => ({ sym: d.sym, score: 0, standing: true, why: d.triggers.map(t => t.why).join('; ') })));
  const pass = { at: startedAt, scope, scanned: symbols.length, dryRun: args.dryRun,
                 budget: cap, flagged, read: [], skipped: skipped.map(d => d.sym) };
  writeLastPass(pass);

  if (!toRead.length) { log('nothing to read this pass.'); return; }

  if (due.length)
    log(due.length + ' coin(s) worth a read, most happened first: ' +
        ranked.map(d => d.sym + (d.score ? ' (' + d.score + ')' : '')).join(', '));
  if (skipped.length)
    log('over the budget of ' + cap + ' this pass, still flagged: ' + skipped.map(d => d.sym).join(', ') +
        ' — not remembered, so they go first next pass if still fresh');
  if (args.dryRun) { log('dry run — no model calls made, state not advanced.'); return; }

  const creds = args.publish ? cloudCreds() : null;
  if (args.publish && !creds)
    log('note: no Cloud credentials found, so reports will be written locally only. ' +
        'See `node mcp/watch.js --help`.');

  for (const d of toRead) {
    log('reading ' + d.sym + '…');
    const readStart = Date.now();
    const res = await runRead(d.sym);
    if (!res.ok) {
      log('  ' + d.sym + ': the read failed — ' + res.error);
      pass.read.push({ sym: d.sym, ok: false, error: res.error }); writeLastPass(pass);
      continue;
    }
    const wrote = reportWrittenSince(d.sym, readStart - 1000);
    if (!wrote) {
      /*  A clean exit with no file is the failure that used to be invisible:
          the model answered, was paid, and did not do the work. Say what it
          said, and leave the trigger unremembered so the next pass retries. */
      const said = String(res.result || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      log('  ' + d.sym + ': the read finished but wrote no report' +
          (res.turns != null ? ' (' + res.turns + ' turn' + (res.turns === 1 ? '' : 's') + ')' : '') +
          (said ? ' — it said: ' + said : ''));
      pass.read.push({ sym: d.sym, ok: false, error: 'no report written' + (said ? ': ' + said.slice(0, 120) : '') }); writeLastPass(pass);
      continue;
    }
    log('  ' + d.sym + ': done — ' + wrote.name + (res.cost != null ? ' ($' + res.cost.toFixed(4) + ')' : ''));
    pass.read.push({ sym: d.sym, ok: true, cost: res.cost == null ? null : res.cost, file: wrote.name }); writeLastPass(pass);

    // only remember a trigger once its read actually succeeded, so a failed
    // pass is retried next hour instead of being silently swallowed
    state = watchRemember(state, d.triggers, Date.now());
    writeState(state);

    if (args.publish && creds) {
      const latest = path.join(VERDICTS, 'latest.json');
      if (!fs.existsSync(latest)) { log('  ' + d.sym + ': no report file was written'); continue; }
      const pub = await publish(latest, creds);
      log('  ' + d.sym + ': ' + pub);
    }
  }

  pass.finishedAt = Date.now(); writeLastPass(pass);
  log('pass complete.');
}

function publish(file, creds) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, 'publish.js'), file], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        ODYSSEUS_CLOUD_EMAIL: creds.email,
        ODYSSEUS_CLOUD_PASSWORD: creds.password,
      }),
    });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve('publish could not start: ' + e.message));
    child.on('close', code => resolve(code === 0
      ? 'published to the app'
      : 'publish failed — ' + err.trim().split('\n').pop()));
  });
}

if (require.main === module) {
  main().catch(e => {
    log('FATAL: ' + (e && e.stack || e));
    process.exit(1);
  });
}

module.exports = {
  watchTriggersFor, watchFilterSeen, watchRemember, watchPruneState, watchSummary,
  watchRank, watchBudget, watchStanding, parseArgs, watchPrompt, watchReportSince, watchLockState,
  WATCH_CFG, FRAME_WEIGHT, runRead,
};

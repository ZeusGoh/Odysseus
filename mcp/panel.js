#!/usr/bin/env node
/* panel.js — the relay behind the buttons in the app's Analyst view.

   A browser tab cannot launch Claude Code. So when you press "Read this coin"
   in Odysseus, the page asks this small local server to run the same command
   the launchers run, and streams the output back so you can watch it without
   a terminal window.

   What it is NOT: an agent, a model, or a way for the app to think. It holds
   no key, calls no model, and has a fixed list of actions. The one place free
   text enters is "ask": your question is written to Claude Code's stdin as a
   prompt — it reaches a model, never a shell — and the reply comes back to
   the app as text. The thinking still happens outside; the app stays what it
   was: a display surface for things something else wrote.

   Security, because a process that spawns things on request deserves it:
     - binds 127.0.0.1 only; nothing off this machine can reach it
     - only accepts requests whose Origin is this machine (localhost, 127.0.0.1,
       or a file opened from disk), or ODYSSEUS_PANEL_ORIGIN if you host the
       app somewhere; a random website in another tab is refused
     - ODYSSEUS_PANEL_TOKEN, if set, is required on every call as well
     - a fixed action list, a symbol regex, and one job at a time

     node mcp/panel.js              start on 127.0.0.1:8790
     node mcp/panel.js --port 9000

   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const bybitLive = require('./bybit-live.js');

const ROOT = path.join(__dirname, '..');
const VERDICTS = path.join(ROOT, 'verdicts');
const WIN = process.platform === 'win32';
const TASK_NAME = 'Odysseus watch';

/* ==PANEL_START== */
const PANEL_VERSION = '0.1.0';
const SYMBOL_RE = /^[A-Z0-9]{1,15}$/;
const LOG_KEEP = 600;

/*  The whole vocabulary. Anything not in this table is refused, which is the
    property that makes it safe to expose to a browser at all.               */
const PANEL_ACTIONS = {
  dry:           { label: "What's worth reading now", costs: false },
  pass:          { label: 'Run the analyst',          costs: true  },
  read:          { label: 'Read this coin',           costs: true  },
  publish:       { label: 'Send latest to Cloud',     costs: false },
  score:         { label: 'Settle the track record',  costs: false },
  'watch-start': { label: 'Start automatic watching', costs: false },
  'watch-stop':  { label: 'Stop automatic watching',  costs: false },
  ask:           { label: 'Ask the analyst',          costs: true  },
};

const ASK_TOOLS = ['Task', 'Read', 'Write', 'WebSearch', 'WebFetch', 'mcp__odysseus-stoch', 'mcp__odysseus-news', 'mcp__odysseus-crowd'];
const CHAT_KEEP = 200;

/*  Who answers a question. Four separate conversations, four separate
    sessions. The desk is the reconciler — the only role allowed to see the
    analysts. The three analysts are the blind ones, and asking one directly
    has to keep it blind: its session is started with ONLY its own MCP server
    loaded (--strict-mcp-config), the other side's tools and the web denied
    outright, no Task so it cannot dispatch anyone, and its own agent file as
    the brief. That is the same separation the /read command gets from
    subagent grants, done with session flags instead.                      */
const ASK_TARGETS = {
  desk: { label: 'the desk', agent: null,
          allow: ASK_TOOLS, deny: [], mcp: null },
  stoch: { label: 'stoch analyst', agent: 'stoch-analyst',
           allow: ['mcp__odysseus-stoch'],
           deny: ['mcp__odysseus-news', 'mcp__odysseus-crowd', 'WebSearch', 'WebFetch', 'Task', 'Write', 'Bash', 'Edit'],
           mcp: 'mcp-stoch.json' },
  news: { label: 'news analyst', agent: 'news-analyst',
          allow: ['mcp__odysseus-news', 'WebSearch', 'WebFetch'],
          deny: ['mcp__odysseus-stoch', 'mcp__odysseus-crowd', 'Task', 'Write', 'Bash', 'Edit'],
          mcp: 'mcp-news.json' },
  crowd: { label: 'crowd analyst', agent: 'crowd-analyst',
           allow: ['mcp__odysseus-crowd'],
           deny: ['mcp__odysseus-stoch', 'mcp__odysseus-news', 'WebSearch', 'WebFetch', 'Task', 'Write', 'Bash', 'Edit'],
           mcp: 'mcp-crowd.json' },
};

function stripFrontmatter(md) {
  const m = String(md || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? String(md).slice(m[0].length) : String(md || '');
}

/*  The first message of a conversation carries the brief; later ones ride
    on --resume, so the session already knows it. Pure given the template. */
function panelAskPrompt(question, isFirst, to, agentMd) {
  const q = String(question || '').trim();
  if (!isFirst) return q + '\n';
  if (to && to !== 'desk') {
    return [
      stripFrontmatter(agentMd).trim(),
      '',
      '---',
      'You are being asked this directly, from inside the Odysseus app, by the',
      'person who runs it. This is a conversation, not a report: answer in plain',
      'prose with the figures inline, and skip the fenced JSON block unless they',
      'ask for it. Everything above still holds — what you can see, what you',
      'cannot, and that you never guess at the other analyst\'s side.',
      '',
      'Question: ' + q,
    ].join('\n') + '\n';
  }
  return [
    'You are the Odysseus analyst desk. The person is asking from inside their',
    'trading app; your reply is shown there as plain text, so no markdown tables',
    'or headings — short paragraphs, figures inline.',
    '',
    'You have two blind subagents: stoch-analyst (the Stochastic indicator and',
    'the backtest record only) and news-analyst (structure, positioning,',
    'headlines and the web only). When a question needs a read, launch BOTH with',
    'the Task tool in one message so neither can see the other, then reconcile —',
    'agreement from different evidence is the strongest signal, a clash is the',
    'useful one, and neither is something to average away. For a full written',
    'read of a coin, Read claude/claude-code-setup/read.md and follow it, so the',
    'report lands in verdicts/ and the app can show it. Keep answers concrete,',
    'quote the numbers, and never speculate past the data.',
    '',
    'Question: ' + q,
  ].join('\n') + '\n';
}

/*  A bounded transcript with a cursor, like the log. Persisted so a relay
    restart does not lose the conversation, and so the app can catch up.  */
class PanelChat {
  constructor(file) { this.file = file || null; this.sessions = {}; this.messages = []; this.base = 0; this.load(); }
  load() {
    if (!this.file) return;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.sessions = j.sessions && typeof j.sessions === 'object' ? j.sessions : {}; this.messages = Array.isArray(j.messages) ? j.messages : []; this.base = j.base || 0; }
    catch (e) { /* none yet */ }
  }
  save() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ sessions: this.sessions, base: this.base, messages: this.messages }, null, 2)); }
    catch (e) { /* best effort */ }
  }
  session(to) { return this.sessions[to || 'desk'] || null; }
  setSession(to, id) { this.sessions[to || 'desk'] = id || null; this.save(); }
  push(role, text, extra) {
    this.messages.push(Object.assign({ at: Date.now(), role, text: String(text || '') }, extra || {}));
    if (this.messages.length > CHAT_KEEP) { const drop = this.messages.length - CHAT_KEEP; this.messages.splice(0, drop); this.base += drop; }
    this.save();
  }
  get next() { return this.base + this.messages.length; }
  since(cursor) { const c = Math.max(Number(cursor) || 0, this.base); return { messages: this.messages.slice(c - this.base), next: this.next, sessions: this.sessions }; }
  /*  Forgetting one thread leaves the others alone: a fresh start with the
      news analyst should not wipe what the stoch analyst was told.       */
  reset(to) {
    const keepNext = this.next;                       // the cursor never goes backwards
    if (to) { this.sessions[to] = null; this.messages = this.messages.filter(m => m.to !== to); }
    else { this.sessions = {}; this.messages = []; }
    this.base = keepNext - this.messages.length;
    this.save();
  }
}

const WATCH_EVERY_MIN = 30;

/*  Action → exactly what gets spawned. Returns {cmd, args, shell}. Starting
    and stopping the automatic pass go through claude/register-watch.ps1 —
    the same script launch/6 and launch/7 run — because schtasks cannot set
    "run a missed pass when the machine wakes" or "never overlap".        */
function panelArgvFor(action, symbol, root, isWin, extra) {
  const r = root || ROOT;
  const win = isWin === undefined ? WIN : isWin;
  switch (action) {
    case 'dry':     return { cmd: process.execPath, args: [path.join(r, 'mcp', 'watch.js'), '--dry-run'], shell: false };
    case 'pass':    return { cmd: process.execPath, args: [path.join(r, 'mcp', 'watch.js')], shell: false };
    case 'read': {
      const sym = String(symbol || '').trim().toUpperCase();
      if (!SYMBOL_RE.test(sym)) throw new Error('symbol must be 1-15 letters or digits, got "' + (symbol || '') + '"');
      return { cmd: process.execPath, args: [path.join(r, 'mcp', 'watch.js'), '--symbols', sym, '--all'], shell: false };
    }
    case 'publish': return { cmd: process.execPath, args: [path.join(r, 'mcp', 'publish.js'), path.join(r, 'verdicts', 'latest.json')], shell: false };
    case 'score':   return { cmd: process.execPath, args: [path.join(r, 'mcp', 'score.js')], shell: false };
    case 'watch-start': {
      if (!win) throw new Error('automatic watching is set up through Windows Task Scheduler; on this OS use cron');
      return { cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
               path.join(r, 'claude', 'register-watch.ps1'), '-Minutes', String(WATCH_EVERY_MIN)], shell: false };
    }
    case 'watch-stop': {
      if (!win) throw new Error('automatic watching is set up through Windows Task Scheduler; on this OS use cron');
      return { cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
               path.join(r, 'claude', 'register-watch.ps1'), '-Remove'], shell: false };
    }
    case 'ask': {
      const x = extra || {};
      const q = String(x.question || '').trim();
      if (!q) throw new Error('nothing was asked');
      if (q.length > 4000) throw new Error('that question is too long (4000 characters max)');
      const to = x.to || 'desk';
      const t = ASK_TARGETS[to];
      if (!t) throw new Error('unknown addressee "' + to + '" — stoch, news, crowd or desk');
      const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk',
                    '--allowedTools', t.allow.join(','), '--max-turns', String(to === 'desk' ? 40 : 15)];
      if (t.deny.length) args.push('--disallowedTools', t.deny.join(','));
      if (t.mcp) args.push('--strict-mcp-config', '--mcp-config', path.join(r, 'claude', 'claude-code-setup', t.mcp));
      if (x.sessionId) args.push('--resume', String(x.sessionId));
      let agentMd = x.agentMd;
      if (t.agent && agentMd == null) {
        for (const f of [path.join(r, '.claude', 'agents', t.agent + '.md'),
                         path.join(r, 'claude', 'claude-code-setup', t.agent + '.md')]) {
          try { agentMd = fs.readFileSync(f, 'utf8'); break; } catch (e) { /* next */ }
        }
        if (agentMd == null) throw new Error('no agent file for ' + t.agent);
      }
      return { cmd: x.bin || process.env.ODYSSEUS_CLAUDE_BIN || 'claude', args, shell: win,
               stdin: panelAskPrompt(q, !x.sessionId, to, agentMd), to };
    }
    default:
      throw new Error('unknown action "' + action + '"');
  }
}

/*  Only this machine. `null` is what a page opened straight from disk sends,
    and localhost on any port is the README's own `python -m http.server`.
    A page on someone else's domain, open in another tab, gets nothing.     */
function panelOriginAllowed(origin, extra) {
  if (origin === undefined || origin === null || origin === 'null' || origin === '') return true;
  const o = String(origin).toLowerCase();
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)) return true;
  const allowed = (extra || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(o);
}

/*  A bounded log with a cursor, so the page can ask "anything since line N"
    and never re-download what it already has.                             */
class PanelLog {
  constructor(keep) { this.keep = keep || LOG_KEEP; this.lines = []; this.base = 0; }
  push(line) {
    this.lines.push(line);
    if (this.lines.length > this.keep) { const drop = this.lines.length - this.keep; this.lines.splice(0, drop); this.base += drop; }
  }
  get next() { return this.base + this.lines.length; }
  since(cursor) {
    const c = Math.max(Number(cursor) || 0, this.base);
    return { lines: this.lines.slice(c - this.base), next: this.next };
  }
  clear() { this.base = this.next; this.lines = []; }
}

// the few fields the status strip shows, from a raw report — or null
function panelSummariseReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw.reconciliation && typeof raw.reconciliation === 'object' ? raw.reconciliation : {};
  const at = Date.parse(raw.generatedAt);
  if (!raw.symbol || !Number.isFinite(at)) return null;
  return {
    symbol: String(raw.symbol).toUpperCase(),
    generatedAt: raw.generatedAt,
    agreement: rec.agreement || null,
    direction: rec.direction || null,
    confidence: Number.isFinite(Number(rec.confidence)) ? Number(rec.confidence) : null,
    headline: typeof rec.headline === 'string' ? rec.headline : null,
    stoch: raw.stoch && raw.stoch.call || null,
    news: raw.news && raw.news.call || null,
  };
}

function panelTokenOk(sent, required) {
  if (!required) return true;
  return typeof sent === 'string' && sent === required;
}
/* ==PANEL_END== */

/* ---------- state ---------- */

const log = new PanelLog();
const chat = new PanelChat(path.join(VERDICTS, '.chat.json'));
let job = null;          // {action, symbol, startedAt, endedAt, code, child}
let cache = { claude: null, watcher: null, watcherAt: 0 };

function claudeInfo() {
  // set on purpose: trust it as given, the same way watch.js does — and read it live, not cached
  if (process.env.ODYSSEUS_CLAUDE_BIN) return { found: true, path: process.env.ODYSSEUS_CLAUDE_BIN };
  if (cache.claude) return cache.claude;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, '.local', 'bin', WIN ? 'claude.exe' : 'claude'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return (cache.claude = { found: true, path: c });
  try {
    const r = spawnSync(WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8', timeout: 4000 });
    const line = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (r.status === 0 && line) return (cache.claude = { found: true, path: line });
  } catch (e) { /* not on PATH */ }
  return (cache.claude = { found: false, path: null });
}

function watcherRegistered() {
  if (!WIN) return null;
  const now = Date.now();
  if (cache.watcher !== null && now - cache.watcherAt < 20000) return cache.watcher;
  try {
    const r = spawnSync('schtasks', ['/query', '/tn', TASK_NAME], { encoding: 'utf8', timeout: 6000 });
    cache.watcher = r.status === 0;
  } catch (e) { cache.watcher = null; }
  cache.watcherAt = now;
  return cache.watcher;
}

function credentialsPresent() {
  if (process.env.ODYSSEUS_CLOUD_EMAIL && process.env.ODYSSEUS_CLOUD_PASSWORD) return true;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return fs.existsSync(path.join(home, '.odysseus-cloud.json'));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function watchlist() {
  const env = process.env.ODYSSEUS_WATCHLIST;
  if (env && env.trim()) return env.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const raw = readJson(path.join(ROOT, 'mcp', 'watchlist.json'));
  const list = Array.isArray(raw) ? raw : (raw && raw.symbols) || [];
  return list.map(s => String(s).trim().toUpperCase()).filter(Boolean);
}

function trackDigests() {
  try {
    const { readTrack, scoreDigest } = require('./score.js');
    return { stoch: scoreDigest(readTrack('stoch'), 24).text, news: scoreDigest(readTrack('news'), 24).text,
             crowd: scoreDigest(readTrack('crowd'), 24).text };
  } catch (e) { return null; }
}

/*  The history: every call, with what price did after. Read from disk on
    every request (cheap: a directory and three small files). The live
    marks — where each still-open call stands right now — need bars from
    the exchange, so they are refreshed at most every HISTORY_LIVE_MS and
    shared between requests; one refresh at a time. The relay never
    settles a checkpoint itself: that stays with score.js, run by a pass
    or the "Settle the track record" button, so two writers never race
    over the record files.                                                */
const HISTORY_LIVE_MS = 120000;
const hist = { liveAt: 0, live: null, liveErr: null, engine: null, refreshing: null };

async function historyLiveMarks(rows) {
  const now = Date.now();
  if (hist.live && now - hist.liveAt < HISTORY_LIVE_MS) return hist.live;
  if (!hist.refreshing) {
    hist.refreshing = (async () => {
      try {
        if (!hist.engine) { const { Engine } = require('./engine.js'); hist.engine = new Engine({}); }
        const { historyLive } = require('./history.js');
        hist.live = await historyLive(hist.engine, rows, now);
        hist.liveErr = null;
      } catch (e) { hist.liveErr = e.message; if (!hist.live) hist.live = {}; }
      hist.liveAt = Date.now();
      hist.refreshing = null;
    })();
  }
  await hist.refreshing;
  return hist.live;
}

async function history(wantLive, limit) {
  const { historyLoad, historyLoadReports, historyMerge, historySummary, SCORE_CHECKS, DEADBAND_PCT } = require('./history.js');
  const { readTrack } = require('./score.js');
  const now = Date.now();
  // the summary is over the whole record; `limit` only trims what is sent
  let rows = historyLoad(now, 0);
  let liveAt = null;
  if (wantLive && rows.some(r => r.open)) {
    const live = await historyLiveMarks(rows);
    rows = historyMerge(historyLoadReports(), readTrack('stoch'), readTrack('news'), now, live, 0, readTrack('crowd'));
    liveAt = hist.liveAt;
  }
  const summary = historySummary(rows);
  return { ok: true, checks: SCORE_CHECKS, deadband: DEADBAND_PCT, rows: rows.slice(0, limit || rows.length), total: rows.length, summary,
           liveAt, liveErr: wantLive ? hist.liveErr : null, at: now };
}

/* ---------- Bybit: the live account line ----------

   The app pastes a read-only key pair here once; the relay verifies it with
   Bybit, keeps it on disk (verdicts/.bybit-key.json, this machine only) and
   answers the app's questions — open positions, closed trades — with its
   own signed requests. The secret never goes back to the browser: status
   carries the key's last four characters and nothing else. Both fetches
   are cached briefly so a view polling every few seconds is one request
   to Bybit, not many.                                                   */
const BYBIT_POSITIONS_CACHE_MS = 10e3;
const BYBIT_TRADES_CACHE_MS = 60e3;
const bybit = { profile: null, verifiedAt: null, lastError: null, lastSyncAt: null,
                positions: null, trades: {} };
/*  Where the key file lives: verdicts/ beside the reports. Tests point this
    at a scratch folder so a run never touches a real key.               */
const bybitDir = () => process.env.ODYSSEUS_BYBIT_KEY_DIR || VERDICTS;

function bybitStatus() {
  const k = bybitLive.bybitLoadKey(bybitDir());
  return {
    ok: true,
    configured: !!k,
    key: k ? bybitLive.bybitMaskKey(k.key) : null,
    source: k ? k.source : null,
    savedAt: k ? k.savedAt : null,
    readOnly: bybit.profile ? bybit.profile.readOnly : (k ? k.readOnly : null),
    expiresAt: bybit.profile ? bybit.profile.expiresAt : null,
    verifiedAt: bybit.verifiedAt,
    lastSyncAt: bybit.lastSyncAt,
    lastError: bybit.lastError,
  };
}

async function bybitConnect(key, secret) {
  const k = String(key || '').trim(), sec = String(secret || '').trim();
  if (!k || !sec) { const e = new Error('both the API key and the secret are needed'); e.status = 400; throw e; }
  if (k.length > 128 || sec.length > 256) { const e = new Error('that does not look like a Bybit key pair'); e.status = 400; throw e; }
  const profile = await bybitLive.bybitVerify(k, sec);        // throws with Bybit's own reason on a bad pair
  bybitLive.bybitSaveKey(bybitDir(), k, sec, profile);
  bybit.profile = profile; bybit.verifiedAt = new Date().toISOString(); bybit.lastError = null;
  bybit.positions = null; bybit.trades = {};
  return Object.assign(bybitStatus(), { grants: profile.grants, permissions: profile.permissions });
}

function bybitForget() {
  bybitLive.bybitForgetKey(bybitDir());
  bybit.profile = null; bybit.verifiedAt = null; bybit.lastError = null; bybit.positions = null; bybit.trades = {};
  return bybitStatus();
}

function bybitNeedKey() {
  const k = bybitLive.bybitLoadKey(bybitDir());
  if (!k) { const e = new Error('Bybit is not connected — paste a read-only API key in the Journal first'); e.status = 409; throw e; }
  return k;
}

async function bybitPositions() {
  const now = Date.now();
  if (bybit.positions && now - bybit.positions.at < BYBIT_POSITIONS_CACHE_MS) return bybit.positions.value;
  const k = bybitNeedKey();
  try {
    const positions = await bybitLive.bybitPositions(k.key, k.secret);
    const value = { ok: true, positions, at: new Date(now).toISOString() };
    bybit.positions = { at: now, value }; bybit.lastError = null;
    return value;
  } catch (e) { bybit.lastError = e.message; throw e; }
}

async function bybitTrades(days) {
  const d = Math.max(1, Math.min(Number(days) || 7, 365));
  const now = Date.now();
  const c = bybit.trades[d];
  if (c && now - c.at < BYBIT_TRADES_CACHE_MS) return c.value;
  const k = bybitNeedKey();
  try {
    const trades = await bybitLive.bybitClosedTrades(k.key, k.secret, d);
    const value = { ok: true, days: d, trades, at: new Date(now).toISOString() };
    bybit.trades[d] = { at: now, value }; bybit.lastSyncAt = value.at; bybit.lastError = null;
    return value;
  } catch (e) { bybit.lastError = e.message; throw e; }
}

function status() {
  return {
    ok: true,
    relay: 'odysseus-panel',
    version: PANEL_VERSION,
    platform: process.platform,
    claude: claudeInfo(),
    credentials: credentialsPresent(),
    watcher: { registered: watcherRegistered(), task: TASK_NAME, everyMin: WATCH_EVERY_MIN },
    watchlist: watchlist(),
    job: job ? { action: job.action, symbol: job.symbol, to: job.to || null, startedAt: job.startedAt, endedAt: job.endedAt, code: job.code, running: job.code === null } : null,
    latest: panelSummariseReport(readJson(path.join(VERDICTS, 'latest.json'))),
    lastPass: readJson(path.join(VERDICTS, '.last-pass.json')),
    trackRecord: trackDigests(),
    actions: PANEL_ACTIONS,
    logNext: log.next,
    chatNext: chat.next,
    chatSessions: Object.keys(ASK_TARGETS).reduce((o, k) => { o[k] = !!chat.session(k); return o; }, {}),
    askTargets: Object.keys(ASK_TARGETS).reduce((o, k) => { o[k] = ASK_TARGETS[k].label; return o; }, {}),
  };
}

function startJob(action, symbol, extra) {
  if (job && job.code === null) { const e = new Error('a job is already running: ' + job.action); e.status = 409; throw e; }
  const to = extra && extra.to ? String(extra.to) : 'desk';
  const x = Object.assign({}, extra || {}, action === 'ask' ? { to, sessionId: chat.session(to), bin: claudeInfo().path || undefined } : {});
  const spec = panelArgvFor(action, symbol, ROOT, WIN, x);   // throws on a bad action, symbol or question
  const stamp = () => new Date().toISOString().slice(11, 19);
  log.clear();
  log.push(stamp() + '  ▶ ' + PANEL_ACTIONS[action].label + (symbol ? ' — ' + String(symbol).toUpperCase() : '') +
           (action === 'ask' ? ' — ' + ASK_TARGETS[to].label : ''));
  if (action === 'ask') chat.push('you', x.question, { to });

  const child = spawn(spec.cmd, spec.args, {
    cwd: ROOT, env: process.env, shell: spec.shell,
    stdio: [spec.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (spec.stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(spec.stdin); }
  job = { action, symbol: symbol ? String(symbol).toUpperCase() : null, to: action === 'ask' ? to : null,
          startedAt: Date.now(), endedAt: null, code: null, child };

  let buf = '';
  const feed = chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      // node's fetch warning on old Node is noise, not news
      if (line && !/ExperimentalWarning|trace-warnings/.test(line)) log.push(line);
    }
  };
  if (action !== 'ask') child.stdout.on('data', d => feed(String(d)));
  child.stderr.on('data', d => feed(String(d)));
  child.on('error', e => { log.push(stamp() + '  ✖ could not start: ' + e.message); job.code = -1; job.endedAt = Date.now(); });
  let raw = '';
  if (action === 'ask') child.stdout.on('data', d => { raw += d; });
  child.on('close', code => {
    if (buf.trim() && action !== 'ask') log.push(buf.trim());
    job.code = code == null ? -1 : code;
    job.endedAt = Date.now();
    if (action === 'ask') {
      /*  --output-format json: the reply is the `result` field; session_id
          is what lets the next question continue the same conversation.  */
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { /* not JSON — treat the text as the reply */ }
      const text = parsed && typeof parsed.result === 'string' ? parsed.result : raw.trim();
      if (code !== 0 || (parsed && parsed.is_error))
        chat.push('analyst', (text || 'the session ended without a reply') + (code !== 0 ? ' (exited ' + code + ')' : ''), { error: true, to });
      else {
        if (parsed && parsed.session_id) chat.setSession(to, parsed.session_id);
        chat.push('analyst', text, { cost: parsed && parsed.total_cost_usd, turns: parsed && parsed.num_turns, to });
      }
      log.push(stamp() + '  ' + (text ? text.slice(0, 200).replace(/\s+/g, ' ') : '(no reply)'));
    }
    log.push(stamp() + (code === 0 ? '  ✔ done' : '  ✖ exited ' + code));
    cache.watcher = null;                                   // it may just have changed
    if (action === 'watch-start' || action === 'watch-stop') cache.watcherAt = 0;
  });
  return status();
}

function stopJob() {
  if (!job || job.code !== null) return status();
  try { job.child.kill(); } catch (e) { /* already gone */ }
  log.push(new Date().toISOString().slice(11, 19) + '  ■ stopped by request');
  return status();
}

/* ---------- HTTP ---------- */

function serve(opts) {
  const o = opts || {};
  const port = o.port !== undefined && o.port !== null ? Number(o.port)
             : Number(process.env.ODYSSEUS_PANEL_PORT || 8790);   // 0 means "any free port" (tests)
  const host = '127.0.0.1';
  const token = o.token !== undefined ? o.token : (process.env.ODYSSEUS_PANEL_TOKEN || '');
  const extraOrigins = o.origins !== undefined ? o.origins : (process.env.ODYSSEUS_PANEL_ORIGIN || '');

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const send = (code, body) => {
      const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin && origin !== 'null' ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Odysseus-Token',
        'Access-Control-Allow-Private-Network': 'true',
        'Vary': 'Origin',
      };
      res.writeHead(code, headers);
      res.end(code === 204 ? undefined : JSON.stringify(body));
    };

    if (!panelOriginAllowed(origin, extraOrigins)) return send(403, { ok: false, error: 'origin not allowed: ' + origin });
    if (req.method === 'OPTIONS') return send(204, {});
    if (!panelTokenOk(req.headers['x-odysseus-token'], token)) return send(401, { ok: false, error: 'token required' });

    const url = new URL(req.url, 'http://' + host);
    const route = req.method + ' ' + url.pathname;

    try {
      if (route === 'GET /status') return send(200, status());
      if (route === 'GET /log') return send(200, Object.assign({ ok: true }, log.since(url.searchParams.get('since')), { job: status().job }));
      if (route === 'GET /watchlog') {
        const n = Math.min(Math.max(Number(url.searchParams.get('lines')) || 60, 1), 400);
        let text = '';
        try { text = fs.readFileSync(path.join(VERDICTS, 'watch.log'), 'utf8'); } catch (e) { /* none yet */ }
        return send(200, { ok: true, lines: text.split(/\r?\n/).filter(Boolean).slice(-n) });
      }
      if (route === 'GET /report/latest') {
        const raw = readJson(path.join(VERDICTS, 'latest.json'));
        return raw ? send(200, { ok: true, report: raw }) : send(404, { ok: false, error: 'no report yet' });
      }
      if (route === 'GET /reports') {
        // every report generated since `since` (ms) — what a whole pass produced,
        // not just the last coin. The app validates each one itself.
        const since = Number(url.searchParams.get('since')) || 0;
        const out = [];
        let names = [];
        try { names = fs.readdirSync(VERDICTS); } catch (e) { /* none yet */ }
        for (const n of names) {
          if (!n.endsWith('.json') || n === 'latest.json' || n === 'example.json' || n.startsWith('.')) continue;
          const raw = readJson(path.join(VERDICTS, n));
          const at = raw && Date.parse(raw.generatedAt);
          if (raw && Number.isFinite(at) && at >= since) out.push(raw);
        }
        out.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
        return send(200, { ok: true, reports: out.slice(0, 50) });
      }
      if (route === 'GET /chat') return send(200, Object.assign({ ok: true }, chat.since(url.searchParams.get('since'))));
      if (route === 'GET /history') {
        // every call the analysts made, with what price did after; ?live=1
        // adds where each still-open call stands right now (bars, cached)
        const wantLive = /^(1|true|yes)$/i.test(url.searchParams.get('live') || '');
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 2000, 1), 5000);
        history(wantLive, limit).then(h => send(200, h)).catch(e => send(500, { ok: false, error: e.message }));
        return;
      }
      if (route === 'GET /bybit/status') return send(200, bybitStatus());
      if (route === 'GET /bybit/positions') {
        bybitPositions().then(v => send(200, v)).catch(e => send(e.status || 502, { ok: false, error: e.message }));
        return;
      }
      if (route === 'GET /bybit/trades') {
        bybitTrades(url.searchParams.get('days')).then(v => send(200, v)).catch(e => send(e.status || 502, { ok: false, error: e.message }));
        return;
      }
      if (route === 'POST /bybit/key' || route === 'POST /bybit/forget') {
        let body = '';
        req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            if (route === 'POST /bybit/forget') return send(200, bybitForget());
            const j = body ? JSON.parse(body) : {};
            bybitConnect(j.key, j.secret).then(v => send(200, v)).catch(e => send(e.status || 502, { ok: false, error: e.message }));
          } catch (e) { return send(e.status || 400, { ok: false, error: e.message }); }
        });
        return;
      }
      if (route === 'POST /chat/reset' || route === 'POST /ask') {
        let body = '';
        req.on('data', d => { body += d; if (body.length > 16384) req.destroy(); });
        req.on('end', () => {
          try {
            const j = body ? JSON.parse(body) : {};
            if (route === 'POST /chat/reset') { chat.reset(j.to ? String(j.to) : null); return send(200, { ok: true, next: chat.next }); }
            return send(200, startJob('ask', null, { question: j.question, to: j.to }));
          } catch (e) { return send(e.status || 400, { ok: false, error: e.message }); }
        });
        return;
      }
      if (route === 'POST /run' || route === 'POST /stop') {
        let body = '';
        req.on('data', d => { body += d; if (body.length > 4096) req.destroy(); });
        req.on('end', () => {
          try {
            if (route === 'POST /stop') return send(200, stopJob());
            const j = body ? JSON.parse(body) : {};
            return send(200, startJob(String(j.action || ''), j.symbol));
          } catch (e) { return send(e.status || 400, { ok: false, error: e.message }); }
        });
        return;
      }
      return send(404, { ok: false, error: 'no such route: ' + route });
    } catch (e) {
      return send(500, { ok: false, error: e.message });
    }
  });

  /*  A second relay on the same port is the one start-up failure that is
      not a bug: launch\10 pressed while the always-on task already holds
      the port, or the task starting under a window left open. Say so and
      exit with a code of its own (3), so relay-hidden.vbs knows to stand
      down rather than retry.                                             */
  server.on('error', e => {
    if (e && e.code === 'EADDRINUSE') {
      process.stderr.write('Odysseus relay: port ' + port + ' is already taken - a relay is already running on this machine ' +
        '(the always-on task, or a launch\\10 window). Nothing to do.\n');
      if (o.onError) return o.onError(e);
      process.exit(3);
    }
    if (o.onError) return o.onError(e);
    throw e;
  });

  server.listen(port, host, () => {
    const bound = server.address().port;
    if (!o.quiet) {
      process.stdout.write('Odysseus relay on http://' + host + ':' + bound + '  (leave this window open)\n');
      process.stdout.write('  claude: ' + (claudeInfo().found ? claudeInfo().path : 'NOT FOUND') + '\n');
      process.stdout.write('  cloud login: ' + (credentialsPresent() ? 'saved' : 'not saved - launch\\9 to set up') + '\n');
      process.stdout.write('  token: ' + (token ? 'required' : 'none (localhost-only origin check)') + '\n');
    }
    if (o.onListen) o.onListen(bound);
  });
  return server;
}

/* ---------- CLI ---------- */

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('node mcp/panel.js [--port N]\n  ODYSSEUS_PANEL_PORT, ODYSSEUS_PANEL_TOKEN, ODYSSEUS_PANEL_ORIGIN\n');
    process.exit(0);
  }
  const pi = args.indexOf('--port');
  serve({ port: pi >= 0 ? args[pi + 1] : undefined });
}

module.exports = {
  panelArgvFor, panelOriginAllowed, panelSummariseReport, panelTokenOk, PanelLog,
  panelAskPrompt, PanelChat, ASK_TOOLS, ASK_TARGETS,
  PANEL_ACTIONS, PANEL_VERSION, SYMBOL_RE, TASK_NAME, WATCH_EVERY_MIN, serve,
};

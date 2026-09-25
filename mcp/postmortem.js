#!/usr/bin/env node
/* postmortem.js — after a miss settles, the news analyst finds out why.

   A grade says a call was wrong; it does not say what the call missed. For
   the news side that is answerable after the fact: the analyst has the
   open web, so it can go back to the window the call covered and find what
   actually moved price — a listing it did not see, a market-wide wave it
   called coin-specific, a squeeze that had already run its course. One or
   two sentences of that, kept on the record next to the miss, is what turns
   "wrong" into a lesson the next brief can carry.

   Only the news side. The stochastic analyst's one tool is a live snapshot
   of the indicator; it has no way to look back at a past window, and asking
   it to guess would put invented history on its record.

   Costs a model call per miss, so it is off unless asked for: `--postmortem`
   on a watch pass, or this file run by hand. Budgeted per pass. Same
   headless driving as watch.js's runRead — the prompt goes in whole on
   stdin, the tool grant is the news analyst's own and nothing else, and the
   file on disk is the only proof it happened.
   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readTrack, writeTrack, scoreRecordMark, scoreMissShape, HOUR } = require('./score.js');

const ROOT = path.join(__dirname, '..');

/* ==POSTMORTEM_START== */
const POSTMORTEM_SIDE = 'news';
const POSTMORTEM_MAX_PER_PASS = 2;
const POSTMORTEM_MAX_AGE_H = 24 * 14;      // older than two weeks is not worth a model call

/*  Misses with no post-mortem yet: settled wrong at the mark the call's own
    horizon named, newest first, capped. Pure.                            */
function postmortemCandidates(records, now, max) {
  const t = now || Date.now();
  const cap = max == null ? POSTMORTEM_MAX_PER_PASS : max;
  return (records || [])
    .filter(r => r && r.symbol && r.checks && (r.call === 'bull' || r.call === 'bear') && !r.postmortem)
    .filter(r => { const c = r.checks[String(scoreRecordMark(r))]; return c && c.grade === 'wrong'; })
    .filter(r => (t - Date.parse(r.generatedAt)) / HOUR <= POSTMORTEM_MAX_AGE_H)
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))
    .slice(0, cap);
}

/*  What the analyst is asked. It gets its own call and its own reason,
    the window, and what price did — nothing about the other analyst or
    the desk. It is told to find, not to excuse.                          */
function postmortemPrompt(record) {
  const mark = scoreRecordMark(record);
  const c = record.checks[String(mark)] || {};
  const from = new Date(record.generatedAt);
  const to = new Date(from.getTime() + mark * HOUR);
  const shape = scoreMissShape(record.call, c);
  const lines = [
    'You are the **news and sentiment analyst** for Odysseus, doing a post-mortem on one of your own calls.',
    '',
    'On ' + from.toISOString() + ' you called **' + record.call + '** on **' + record.symbol + '**' +
      (record.conviction != null ? ' at conviction ' + record.conviction : '') +
      (record.horizon ? ', horizon "' + record.horizon + '"' : '') +
      (record.setup ? ' (' + record.setup + ')' : '') + '.',
    record.claim ? 'Your first stated reason was: "' + record.claim + '"' : '',
    'By ' + to.toISOString() + ' (' + mark + 'h later) price had moved ' + (c.pct > 0 ? '+' : '') + c.pct + '%' +
      (c.btcPct != null ? ' while BTC moved ' + (c.btcPct > 0 ? '+' : '') + c.btcPct + '%' : '') +
      (shape ? ' — it ' + shape : '') + '. The call was wrong.',
    '',
    'Find out what actually happened to ' + record.symbol + ' in that window. Use `get_watchlist` for the coin\'s real name, ' +
      'then search the web for that name and those dates: a listing, an unlock, a hack, a market-wide move, a squeeze, ' +
      'a headline you did not have. `get_news_snapshot` shows the present, not that window — use it only to confirm the coin\'s name and book.',
    '',
    'Then answer in at most three sentences: (1) what actually drove price in that window, with a source if you found one; ' +
      '(2) what in your reasoning at the time missed it — a wrong classification, a catalyst you weighed wrongly, a squeeze you read as demand, ' +
      'or simply something that was not findable then. Do not defend the call. "Nothing findable, the move looks like the market" is a real answer.',
    '',
    'End your message with exactly this fenced block:',
    '',
    '```json',
    '{ "postmortem": "<your two or three sentences>" }',
    '```',
  ];
  return lines.filter(l => l !== null).join('\n') + '\n';
}

/*  The sentences out of whatever came back: the fenced block if it is there,
    else the last paragraph. Never more than a few hundred characters —
    this goes into a brief, not a report.                                 */
function postmortemParse(text) {
  const s = String(text || '');
  const m = s.match(/```json\s*([\s\S]*?)```/i);
  if (m) {
    try { const j = JSON.parse(m[1]); if (j && typeof j.postmortem === 'string' && j.postmortem.trim()) return j.postmortem.trim().slice(0, 600); }
    catch (e) { /* fall through */ }
  }
  const paras = s.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const last = paras.length ? paras[paras.length - 1] : '';
  return last ? last.replace(/\s+/g, ' ').slice(0, 600) : null;
}
/* ==POSTMORTEM_END== */

/* ---------- plumbing ---------- */

function runPostmortem(record, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    const prompt = postmortemPrompt(record);
    const args = [
      '-p', '--output-format', 'json', '--permission-mode', 'dontAsk',
      '--allowedTools', ['WebSearch', 'WebFetch', 'mcp__odysseus-news'].join(','),
      '--max-turns', String(o.maxTurns || 15),
    ];
    const bin = o.command || process.env.ODYSSEUS_CLAUDE_BIN || 'claude';
    const child = spawn(bin, args, { cwd: ROOT, env: process.env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'timed out' }); }, o.timeoutMs || 300000);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: 'could not start "' + bin + '": ' + e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (e) { /* plain text */ }
      const said = parsed && typeof parsed.result === 'string' ? parsed.result : out;
      if (code !== 0) return resolve({ ok: false, error: 'exited ' + code + ': ' + [err.trim(), out.trim()].filter(Boolean).join(' | ').slice(0, 600) });
      if (parsed && parsed.is_error) return resolve({ ok: false, error: 'the model reported an error: ' + String(said).slice(0, 300) });
      const text = postmortemParse(said);
      if (!text) return resolve({ ok: false, error: 'nothing usable came back' });
      resolve({ ok: true, text, cost: parsed && parsed.total_cost_usd });
    });
  });
}

/*  One pass: find the misses, ask about each, write the answers onto the
    news record. Re-reads the file before writing so a settle that ran in
    between is not clobbered. Returns what it did, for the log.          */
async function postmortemPass(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const dir = o.dir;
  const log = o.log || (() => {});
  const cands = postmortemCandidates(readTrack(POSTMORTEM_SIDE, dir), now, o.max);
  const done = [];
  if (!cands.length) { log('post-mortems: no new misses to explain'); return done; }
  log('post-mortems: ' + cands.length + ' miss(es) to explain');
  for (const r of cands) {
    if (o.dryRun) { log('  ' + r.symbol + ' ' + r.call + ' on ' + String(r.generatedAt).slice(0, 10) + ': would ask (dry run)'); continue; }
    const res = await runPostmortem(r, o);
    if (!res.ok) { log('  ' + r.symbol + ': ' + res.error); continue; }
    const records = readTrack(POSTMORTEM_SIDE, dir);
    const live = records.find(x => x.id === r.id);
    if (!live) continue;
    live.postmortem = { text: res.text, at: new Date(now).toISOString(), cost: res.cost == null ? null : res.cost };
    writeTrack(POSTMORTEM_SIDE, records, dir);
    done.push({ id: r.id, symbol: r.symbol, text: res.text });
    log('  ' + r.symbol + ': ' + res.text.slice(0, 120) + (res.text.length > 120 ? '…' : '') + (res.cost != null ? ' ($' + res.cost.toFixed(4) + ')' : ''));
  }
  return done;
}

const USAGE = `
Odysseus post-mortems — the news analyst explains its own settled misses

  node mcp/postmortem.js             explain up to ${POSTMORTEM_MAX_PER_PASS} new misses
  node mcp/postmortem.js --max N     a different budget
  node mcp/postmortem.js --dry-run   list what would be asked, spend nothing
`.trim();

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE + '\n'); return; }
  const mi = args.indexOf('--max');
  const max = mi >= 0 ? Number(args[mi + 1]) : undefined;
  await postmortemPass({ max, dryRun: args.includes('--dry-run'), log: l => process.stdout.write(l + '\n') });
}

if (require.main === module) {
  main().catch(e => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
}

module.exports = {
  postmortemCandidates, postmortemPrompt, postmortemParse, runPostmortem, postmortemPass,
  POSTMORTEM_SIDE, POSTMORTEM_MAX_PER_PASS, POSTMORTEM_MAX_AGE_H,
};

/* panel.test.js — the relay behind the app's analyst buttons.

   A process that spawns things when a web page asks deserves its guard rails
   pinned: a fixed vocabulary of actions and nothing else, a symbol that cannot
   smuggle in an argument, an origin check that keeps other websites out, and
   a log cursor that never re-sends what the page already has. Then one real
   round trip over HTTP against the fake exchange, because the wiring between
   the route, the spawn and the log is exactly the part a unit test cannot see.
   part of Odysseus */

const path = require('path');
const http = require('http');
const MCP = path.join(__dirname, '..', 'mcp');
const {
  panelArgvFor, panelOriginAllowed, panelSummariseReport, panelTokenOk, PanelLog,
  PANEL_ACTIONS, TASK_NAME, serve, panelAskPrompt, PanelChat, ASK_TOOLS, ASK_TARGETS,
} = require(path.join(MCP, 'panel.js'));

const ROOT = path.join(__dirname, '..');

suite('panel — a fixed vocabulary, nothing else');
check('eight actions, no more', Object.keys(PANEL_ACTIONS).length, 8);
throws('an unknown action is refused', () => panelArgvFor('shell', null, ROOT, true));
throws('an empty action is refused', () => panelArgvFor('', null, ROOT, true));
ok('a dry run is watch.js --dry-run',
   panelArgvFor('dry', null, ROOT, true).args.join(' ').endsWith('watch.js --dry-run'));
ok('a pass is plain watch.js', panelArgvFor('pass', null, ROOT, true).args.join(' ').endsWith('watch.js'));
ok('none of the node actions go through a shell',
   ['dry', 'pass', 'publish', 'score'].every(a => panelArgvFor(a, null, ROOT, true).shell === false));
ok('publish targets latest.json',
   panelArgvFor('publish', null, ROOT, true).args[1].endsWith(path.join('verdicts', 'latest.json')));

suite('panel — the symbol cannot carry anything but a ticker');
check('a ticker is upper-cased', panelArgvFor('read', 'sol', ROOT, true).args.slice(-2), ['SOL', '--all']);
throws('a shell metacharacter is refused', () => panelArgvFor('read', 'SOL; rm -rf /', ROOT, true));
throws('a flag is refused', () => panelArgvFor('read', '--all', ROOT, true));
throws('an empty symbol is refused', () => panelArgvFor('read', '', ROOT, true));
throws('a space is refused', () => panelArgvFor('read', 'SOL BTC', ROOT, true));
throws('too long is refused', () => panelArgvFor('read', 'A'.repeat(16), ROOT, true));
check('1000PEPE is fine', panelArgvFor('read', '1000pepe', ROOT, true).args.slice(-2)[0], '1000PEPE');

suite('panel — start and stop go through the same script the launchers use');
{
  const start = panelArgvFor('watch-start', null, 'C:\\VL', true);
  ok('start runs register-watch.ps1', start.cmd === 'powershell' && start.args.some(a => a.endsWith('register-watch.ps1')));
  ok('with no shell in between', start.shell === false);
  check('every thirty minutes', start.args.slice(-2), ['-Minutes', '30']);
  const stop = panelArgvFor('watch-stop', null, 'C:\\VL', true);
  ok('stop runs the same script with -Remove', stop.args.some(a => a.endsWith('register-watch.ps1')) && stop.args.includes('-Remove'));
  throws('and neither exists off Windows', () => panelArgvFor('watch-start', null, ROOT, false));
}

suite('panel — a question goes to the model, never to a shell');
{
  const a = panelArgvFor('ask', null, ROOT, true, { question: 'what about SUI?', bin: 'C:\\x\\claude.exe' });
  check('it runs claude', a.cmd, 'C:\\x\\claude.exe');
  ok('in print mode with JSON out', a.args.includes('-p') && a.args.includes('json'));
  ok('the question is NOT on the command line', !a.args.some(x => /SUI/.test(x)));
  ok('it goes in on stdin', /what about SUI\?/.test(a.stdin));
  ok('the first message carries the desk brief', /two blind subagents/.test(a.stdin));
  ok('the tools are the read\'s tools, no shell', ASK_TOOLS.every(t => a.args[a.args.indexOf('--allowedTools') + 1].includes(t)) && !/Bash/.test(a.args.join(' ')));
  ok('no session, no --resume', !a.args.includes('--resume'));
  const b = panelArgvFor('ask', null, ROOT, true, { question: 'and ETH?', sessionId: 'sess-1', bin: 'claude' });
  ok('a follow-up resumes the session', b.args[b.args.indexOf('--resume') + 1] === 'sess-1');
  ok('and carries no brief the second time', !/two blind subagents/.test(b.stdin) && /and ETH\?/.test(b.stdin));
  throws('an empty question is refused', () => panelArgvFor('ask', null, ROOT, true, { question: '   ' }));
  throws('a novel is refused', () => panelArgvFor('ask', null, ROOT, true, { question: 'x'.repeat(4001) }));
  ok('a shell metacharacter in a question is just text', /rm -rf/.test(panelArgvFor('ask', null, ROOT, true, { question: 'is `rm -rf` a coin?' }).stdin));
}

suite('panel — asking an analyst directly keeps it blind');
{
  const agent = '---\nname: stoch-analyst\ntools:\n  - mcp__odysseus-stoch\n---\n\nYou are the **stochastic analyst**. You do not have news.\n';
  const st = panelArgvFor('ask', null, ROOT, true, { question: 'how is SUI set up?', to: 'stoch', bin: 'claude', agentMd: agent });
  const allow = st.args[st.args.indexOf('--allowedTools') + 1];
  const deny = st.args[st.args.indexOf('--disallowedTools') + 1];
  check('the stoch analyst may use only its own server', allow, 'mcp__odysseus-stoch');
  ok('the news server is denied outright', /mcp__odysseus-news/.test(deny));
  ok('and so is the web', /WebSearch/.test(deny) && /WebFetch/.test(deny));
  ok('and it cannot dispatch anyone or write', /Task/.test(deny) && /Write/.test(deny));
  ok('only its own MCP server is even loaded', st.args.includes('--strict-mcp-config') &&
     st.args[st.args.indexOf('--mcp-config') + 1].endsWith('mcp-stoch.json'));
  ok('its own agent file is the brief', /stochastic analyst/.test(st.stdin) && !/^---/.test(st.stdin));
  ok('told this is a conversation, not a report', /not a report/.test(st.stdin));
  ok('and the question is at the end', /Question: how is SUI set up\?/.test(st.stdin));
  ok('a shorter leash than the desk', Number(st.args[st.args.indexOf('--max-turns') + 1]) < 40);

  const nw = panelArgvFor('ask', null, ROOT, true, { question: 'why did ZEC move?', to: 'news', bin: 'claude', agentMd: 'news brief' });
  const nAllow = nw.args[nw.args.indexOf('--allowedTools') + 1];
  ok('the news analyst gets its server and the web', /mcp__odysseus-news/.test(nAllow) && /WebSearch/.test(nAllow));
  ok('and not the stoch server', !/mcp__odysseus-stoch/.test(nAllow) && /mcp__odysseus-stoch/.test(nw.args[nw.args.indexOf('--disallowedTools') + 1]));
  ok('with only its own MCP config', nw.args[nw.args.indexOf('--mcp-config') + 1].endsWith('mcp-news.json'));

  const dk = panelArgvFor('ask', null, ROOT, true, { question: 'full read on LINK', to: 'desk', bin: 'claude' });
  ok('the desk keeps every tool and both servers', !dk.args.includes('--strict-mcp-config') && /mcp__odysseus-stoch,mcp__odysseus-news/.test(dk.args[dk.args.indexOf('--allowedTools') + 1]));
  throws('an unknown addressee is refused', () => panelArgvFor('ask', null, ROOT, true, { question: 'x', to: 'grok', bin: 'claude' }));
  ok('the real agent files are found on disk', /stochastic analyst/.test(panelArgvFor('ask', null, ROOT, true, { question: 'x', to: 'stoch', bin: 'claude' }).stdin));
  check('four addressees', Object.keys(ASK_TARGETS).sort(), ['crowd', 'desk', 'news', 'stoch']);
  check('the crowd analyst is held to its own server, no web, no dispatch',
        [ASK_TARGETS.crowd.allow, ASK_TARGETS.crowd.deny.includes('WebSearch') && ASK_TARGETS.crowd.deny.includes('Task') && ASK_TARGETS.crowd.deny.includes('mcp__odysseus-news')],
        [['mcp__odysseus-crowd'], true]);
}

suite('panel — the conversation is a bounded transcript with a cursor');
{
  const c = new PanelChat(null);                 // no file: in memory only
  check('empty to start', c.since(0).messages, []);
  c.push('you', 'hi', { to: 'stoch' }); c.push('analyst', 'hello', { cost: 0.01, to: 'stoch' });
  c.push('you', 'news?', { to: 'news' }); c.push('analyst', 'board move', { to: 'news' });
  check('both sides are kept in order', c.since(0).messages.map(m => m.role), ['you', 'analyst', 'you', 'analyst']);
  check('a cost rides along', c.since(0).messages[1].cost, 0.01);
  check('the cursor moves past them', c.since(0).next, 4);
  check('nothing new since the cursor', c.since(4).messages, []);
  c.setSession('stoch', 's1'); c.setSession('news', 's2');
  check('sessions are per addressee', [c.session('stoch'), c.session('news'), c.session('desk')], ['s1', 's2', null]);
  c.reset('stoch');
  check('resetting one thread forgets its session', c.session('stoch'), null);
  check('and its messages only', c.since(0).messages.map(m => m.to), ['news', 'news']);
  check('the other session survives', c.session('news'), 's2');
  check('and the cursor never goes backwards', c.since(0).next, 4);
  c.reset();
  check('a full reset clears everything', [c.since(0).messages, c.session('news')], [[], null]);
  check('cursor still monotonic', c.since(0).next, 4);
}

suite('panel — only this machine may ask');
ok('a file opened from disk (null origin) is allowed', panelOriginAllowed('null'));
ok('no origin header at all is allowed', panelOriginAllowed(undefined));
ok('localhost:8000 — the README\'s own server — is allowed', panelOriginAllowed('http://localhost:8000'));
ok('127.0.0.1 on any port is allowed', panelOriginAllowed('http://127.0.0.1:5500'));
ok('https localhost is allowed too', panelOriginAllowed('https://localhost'));
ok('someone else\'s website is refused', !panelOriginAllowed('https://evil.example'));
ok('a look-alike is refused', !panelOriginAllowed('http://localhost.evil.example'));
ok('a hosted copy is allowed only when named', panelOriginAllowed('https://odysseus.example', 'https://odysseus.example'));
ok('and the extra list is exact', !panelOriginAllowed('https://odysseus.example', 'https://other.example'));

suite('panel — the token, when one is set');
ok('no token configured means no token needed', panelTokenOk(undefined, ''));
ok('the right token passes', panelTokenOk('abc', 'abc'));
ok('the wrong token fails', !panelTokenOk('abd', 'abc'));
ok('a missing token fails when one is required', !panelTokenOk(undefined, 'abc'));

suite('panel — the log never re-sends what the page has');
{
  const l = new PanelLog(5);
  ['a', 'b', 'c'].forEach(x => l.push(x));
  check('everything from zero', l.since(0).lines, ['a', 'b', 'c']);
  check('and the cursor points past it', l.since(0).next, 3);
  check('nothing new since the cursor', l.since(3).lines, []);
  ['d', 'e', 'f', 'g'].forEach(x => l.push(x));
  check('it is bounded', l.lines.length, 5);
  check('a cursor from before the window is clamped, not an error', l.since(0).lines, ['c', 'd', 'e', 'f', 'g']);
  check('and a live cursor still gets only what is new', l.since(6).lines, ['g']);
  l.clear();
  check('clearing keeps the cursor monotonic', l.since(0).next, 7);
  check('and leaves nothing behind', l.since(0).lines, []);
}

suite('panel — the status strip reads only a few fields');
{
  const s = panelSummariseReport({
    schema: 'odysseus.analyst.v1', symbol: 'zec', generatedAt: '2026-09-16T22:08:31Z',
    stoch: { call: 'bull' }, news: { call: 'bull' },
    reconciliation: { agreement: 'partial', direction: 'bull', confidence: 55, headline: 'h' },
  });
  check('symbol is upper-cased', s.symbol, 'ZEC');
  check('the two calls come through', [s.stoch, s.news], ['bull', 'bull']);
  check('so does the reconciliation', [s.agreement, s.direction, s.confidence], ['partial', 'bull', 55]);
  check('nothing is nothing', panelSummariseReport(null), null);
  check('a report with no date is nothing', panelSummariseReport({ symbol: 'X' }), null);
}

/* ---- one real round trip: route → spawn → log, against the fake exchange ---- */
later(async () => {
  suite('panel — a dry run over HTTP, end to end');
  const { start } = require(path.join(MCP, 'test', 'fakebybit.js'));
  const fake = await start();
  process.env.ODYSSEUS_HOST_MAP = JSON.stringify(fake.hostMap);
  process.env.ODYSSEUS_WATCHLIST = 'SOL,SQUEZ';

  const port = await new Promise(res => { serve({ port: 0, token: '', quiet: true, onListen: res }); });

  const call = (method, p, body, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, r => {
      let s = ''; r.on('data', d => s += d); r.on('end', () => resolve({ code: r.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

  const st = await call('GET', '/status');
  check('status answers', st.code, 200);
  ok('and names itself', st.body.relay === 'odysseus-panel');
  check('the watchlist comes from the environment', st.body.watchlist, ['SOL', 'SQUEZ']);
  ok('no job to begin with', st.body.job === null);

  const bad = await call('GET', '/status', undefined, { Origin: 'https://evil.example' });
  check('another website gets nothing', bad.code, 403);

  const nope = await call('POST', '/run', { action: 'shell' });
  check('an unknown action is a 400', nope.code, 400);

  const run = await call('POST', '/run', { action: 'dry' });
  check('a dry run starts', run.code, 200);
  ok('and is reported as running', run.body.job && run.body.job.running === true);

  const again = await call('POST', '/run', { action: 'dry' });
  check('a second one while it runs is a 409', again.code, 409);

  let done = null;
  for (let i = 0; i < 100 && !done; i++) {
    await new Promise(r => setTimeout(r, 150));
    const s = await call('GET', '/status');
    if (s.body.job && !s.body.job.running) done = s.body.job;
  }
  ok('it finishes', !!done);
  check('cleanly', done && done.code, 0);

  const lg = await call('GET', '/log?since=0');
  const text = lg.body.lines.join('\n');
  ok('the log shows the gate deciding', /worth a read|nothing to read/.test(text));
  ok('and that no model call was made', /dry run/.test(text));
  ok('and the relay marked it done', /done/.test(lg.body.lines[lg.body.lines.length - 1]));

  // ask: a stub "claude" that echoes what it was asked and hands back a session id
  const stub = path.join(require('os').tmpdir(), 'odysseus-stub-claude-' + process.pid + (process.platform === 'win32' ? '.cmd' : ''));
  const body = "const q=require('fs').readFileSync(0,'utf8');process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'echo: '+q.trim().split('\\n').pop(),session_id:'sess-42',total_cost_usd:0.002,num_turns:1})+'\\n');";
  if (process.platform === 'win32') {
    require('fs').writeFileSync(stub + '.js', body);
    require('fs').writeFileSync(stub, '@echo off\r\n"' + process.execPath + '" "' + stub + '.js"\r\n');
  } else {
    require('fs').writeFileSync(stub, '#!' + process.execPath + '\n' + body, { mode: 0o755 });
  }
  process.env.ODYSSEUS_CLAUDE_BIN = stub;
  const asked = await call('POST', '/ask', { question: 'what about SUI?', to: 'stoch' });
  check('a question starts a job', asked.code, 200);
  let doneAsk = null;
  for (let i = 0; i < 60 && !doneAsk; i++) { await new Promise(r => setTimeout(r, 100)); const s = await call('GET', '/status'); if (s.body.job && !s.body.job.running) doneAsk = s.body.job; }
  ok('and it finishes', !!doneAsk);
  const chat = await call('GET', '/chat?since=0');
  check('the transcript has the question and the reply', chat.body.messages.map(m => m.role), ['you', 'analyst']);
  ok('the reply is what the model said', /echo: Question: what about SUI\?/.test(chat.body.messages[1].text));
  ok('the session id was kept for the next question', chat.body.sessions && chat.body.sessions.stoch === 'sess-42');
  ok('and the thread is tagged with who answered', chat.body.messages.every(m => m.to === 'stoch'));
  const reset = await call('POST', '/chat/reset', { to: 'stoch' });
  check('a reset answers', reset.code, 200);
  check('and the transcript is empty', (await call('GET', '/chat?since=0')).body.messages, []);
  delete process.env.ODYSSEUS_CLAUDE_BIN;

  /* ---------- the Bybit line, against a fake exchange ---------- */
  suite('panel — Bybit: connect with a read-only key, read positions and trades, disconnect');
  {
    const live = require(path.join(MCP, 'bybit-live.js'));
    const fs = require('fs');
    const savedEnv = [process.env.ODYSSEUS_BYBIT_KEY, process.env.ODYSSEUS_BYBIT_SECRET, process.env.ODYSSEUS_BYBIT_KEY_DIR];
    delete process.env.ODYSSEUS_BYBIT_KEY; delete process.env.ODYSSEUS_BYBIT_SECRET;
    // the key file goes in a scratch folder: a test run never reads or replaces a real key
    const keyDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'odysseus-bybit-'));
    process.env.ODYSSEUS_BYBIT_KEY_DIR = keyDir;
    const keyFile = live.bybitKeyPath(keyDir);
    let calls = 0;
    live.bybitSetFetch(async (url, opts) => {
      calls++;
      const u = new URL(url);
      const ok = result => ({ ok: true, json: async () => ({ retCode: 0, retMsg: 'OK', result }) });
      if (opts.headers['X-BAPI-API-KEY'] !== 'GOODKEY') return { ok: true, json: async () => ({ retCode: 10003, retMsg: 'API key is invalid.' }) };
      if (u.pathname === '/v5/user/query-api') return ok({ readOnly: 1, permissions: { ContractTrade: ['Position'] }, expiredAt: '-1' });
      if (u.pathname === '/v5/position/list') return ok({ list: [{ symbol: 'SOLUSDT', side: 'Buy', size: '2', avgPrice: '150', markPrice: '153', positionValue: '306', unrealisedPnl: '6', leverage: '3' }], nextPageCursor: '' });
      if (u.pathname === '/v5/position/closed-pnl') return ok({ list: [{ symbol: 'SOLUSDT', side: 'Sell', avgEntryPrice: '160', avgExitPrice: '150', closedSize: '1', orderId: 'o9', createdTime: '1700000000000', updatedTime: '1700003600000' }], nextPageCursor: '' });
      return { ok: false, status: 404, statusText: 'nope', json: async () => ({}) };
    });
    try {
      const st0 = await call('GET', '/bybit/status');
      check('not connected to begin with', [st0.code, st0.body.configured, st0.body.key], [200, false, null]);
      const pos0 = await call('GET', '/bybit/positions');
      check('positions without a key is a plain refusal, not a crash', [pos0.code, /not connected/.test(pos0.body.error)], [409, true]);
      const bad = await call('POST', '/bybit/key', { key: 'WRONG', secret: 'x' });
      check('a bad pair is refused with Bybit\'s reason and nothing is saved', [bad.code, /API key is invalid/.test(bad.body.error), fs.existsSync(keyFile)], [502, true, false]);
      const half = await call('POST', '/bybit/key', { key: 'GOODKEY' });
      check('half a pair is refused before Bybit is asked', [half.code, /both/.test(half.body.error)], [400, true]);
      const good = await call('POST', '/bybit/key', { key: 'GOODKEY', secret: 'sekrit' });
      check('a good pair connects, verified read-only, and the secret never comes back', [good.code, good.body.configured, good.body.readOnly, good.body.key, 'secret' in good.body], [200, true, true, '••••DKEY', false]);
      ok('and is kept on disk for next time, owner-readable only', fs.existsSync(keyFile) && JSON.parse(fs.readFileSync(keyFile, 'utf8')).key === 'GOODKEY');
      const pos = await call('GET', '/bybit/positions');
      check('positions come through mapped', [pos.code, pos.body.positions.length, pos.body.positions[0].symbol, pos.body.positions[0].unrealisedPct], [200, 1, 'SOL', 2]);
      const before = calls;
      await call('GET', '/bybit/positions');
      check('a second ask inside the cache window is not a second request to Bybit', calls, before);
      const tr = await call('GET', '/bybit/trades?days=3');
      check('closed trades come through in the journal\'s shape', [tr.code, tr.body.days, tr.body.trades[0].direction, tr.body.trades[0].sourceId], [200, 3, 'short', 'bybit:o9']);
      const st1 = await call('GET', '/bybit/status');
      ok('status now carries the last sync time', !!st1.body.lastSyncAt);
      const off = await call('POST', '/bybit/forget', {});
      check('disconnecting deletes the key file', [off.code, off.body.configured, fs.existsSync(keyFile)], [200, false, false]);
    } finally {
      live.bybitSetFetch(null);
      try { fs.rmSync(keyDir, { recursive: true, force: true }); } catch (e) {}
      if (savedEnv[0] === undefined) delete process.env.ODYSSEUS_BYBIT_KEY; else process.env.ODYSSEUS_BYBIT_KEY = savedEnv[0];
      if (savedEnv[1] === undefined) delete process.env.ODYSSEUS_BYBIT_SECRET; else process.env.ODYSSEUS_BYBIT_SECRET = savedEnv[1];
      if (savedEnv[2] === undefined) delete process.env.ODYSSEUS_BYBIT_KEY_DIR; else process.env.ODYSSEUS_BYBIT_KEY_DIR = savedEnv[2];
    }
  }
  try { require('fs').unlinkSync(stub); require('fs').unlinkSync(stub + '.js'); } catch (e) {}

  const st2 = await call('GET', '/status');
  ok('the pass left a record the app can show', !!(st2.body.lastPass && st2.body.lastPass.at));
  check('with the scope it ran at', st2.body.lastPass.scope, 'watchlist');
  ok('and what it flagged', Array.isArray(st2.body.lastPass.flagged));

  const reps = await call('GET', '/reports?since=0');
  check('reports answers', reps.code, 200);
  ok('as a list', Array.isArray(reps.body.reports));
  ok('and never the schema example', !reps.body.reports.some(r => r.symbol === 'SOL' && /tradeable 4H/.test(r.reconciliation && r.reconciliation.headline)));

  // the history: every call against what price did — read from disk, no network
  const hs = await call('GET', '/history');
  check('history answers', hs.code, 200);
  check('with the four marks', hs.body.checks, [24, 48, 72, 168]);
  check('and the deadband the grades use', hs.body.deadband, 0.5);
  ok('rows are a list', Array.isArray(hs.body.rows));
  ok('every row has all three sides graded', hs.body.rows.every(r => r.stoch && r.stoch.grades && r.news && r.news.grades && r.desk && r.desk.grades));
  ok('and a price path with every mark', hs.body.rows.every(r => r.price && [24, 48, 72, 168].every(h => r.price.checks[String(h)])));
  check('the summary covers stoch, news, crowd and the desk', Object.keys(hs.body.summary).sort(), ['crowd', 'desk', 'news', 'stoch']);
  ok('no live marks were asked for, none were fetched', hs.body.liveAt === null);
  ok('the schema example is not a call', !hs.body.rows.some(r => r.id === 'example'));
  const hl = await call('GET', '/history?live=1&limit=5');
  check('asking for live marks still answers', hl.code, 200);
  ok('and the limit is honoured', hl.body.rows.length <= 5);
  ok('a live fetch is stamped, or there was nothing open to fetch', typeof hl.body.liveAt === 'number' || !hl.body.rows.some(r => r.open));

  await fake.close();
});

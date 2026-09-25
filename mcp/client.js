/* client.js — a minimal MCP client, for testing the server and for driving it
   from a script (the unattended two-analyst run needs exactly this and nothing
   more). Dependency-free, same reasoning as protocol.js.

   const {connectHttp, connectStdio} = require('./client');
   const c = await connectHttp('http://127.0.0.1:8787/mcp', {token});
   await c.listTools();
   await c.callTool('get_stoch_snapshot', {symbol:'SOL'});
   part of Odysseus */

'use strict';

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'odysseus-test-client', version: '0.1.0' };

function unwrap(res) {
  if (res.error) {
    const e = new Error(res.error.message || 'the server returned an error');
    e.code = res.error.code;
    e.data = res.error.data;
    throw e;
  }
  return res.result;
}

/*  A tool result carries its payload twice: structuredContent for a machine,
    and a text block for a model. Prefer the structured one, fall back to
    parsing the text, and surface isError as a thrown error so a test cannot
    quietly pass on a failure.                                              */
function toolPayload(result) {
  if (result.isError) {
    const text = (result.content || []).map(c => c.text).join('\n');
    const e = new Error('tool reported an error: ' + text);
    e.toolError = true;
    throw e;
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch (e) { return text; }
}

function makeClient(send, close) {
  let nextId = 1;
  const api = {
    async request(method, params) {
      const id = nextId++;
      return unwrap(await send({ jsonrpc: '2.0', id, method, params: params || {} }));
    },
    async notify(method, params) {
      await send({ jsonrpc: '2.0', method, params: params || {} }, true);
    },
    async initialize() {
      const res = await api.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      await api.notify('notifications/initialized');
      return res;
    },
    async listTools() { return (await api.request('tools/list')).tools; },
    async callTool(name, args) {
      return toolPayload(await api.request('tools/call', { name, arguments: args || {} }));
    },
    async callToolRaw(name, args) {
      return api.request('tools/call', { name, arguments: args || {} });
    },
    async ping() { return api.request('ping'); },
    close,
  };
  return api;
}

async function connectHttp(url, opts) {
  const o = opts || {};
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (o.token) headers.authorization = 'Bearer ' + o.token;

  const send = async (msg, isNotification) => {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg) });
    if (isNotification) { await res.arrayBuffer(); return null; }
    if (!res.ok && res.status !== 200) {
      const body = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* not JSON */ }
      if (parsed && parsed.error) return parsed;
      throw new Error('HTTP ' + res.status + ': ' + body.slice(0, 300));
    }
    return res.json();
  };

  const client = makeClient(send, async () => {});
  await client.initialize();
  return client;
}

async function connectStdio(command, args, opts) {
  const o = opts || {};
  const child = spawn(command, args || [], {
    stdio: ['pipe', 'pipe', o.stderr === 'inherit' ? 'inherit' : 'pipe'],
    env: Object.assign({}, process.env, o.env || {}),
  });
  if (child.stderr && o.stderr !== 'inherit') child.stderr.resume();

  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter.resolve(msg); }
    }
  });

  const send = (msg, isNotification) => new Promise((resolve, reject) => {
    if (!isNotification) {
      pending.set(msg.id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(msg.id)) { pending.delete(msg.id); reject(new Error('timed out waiting for ' + msg.method)); }
      }, o.timeoutMs || 120000).unref?.();
    }
    child.stdin.write(JSON.stringify(msg) + '\n', err => {
      if (err) reject(err);
      else if (isNotification) resolve(null);
    });
  });

  const client = makeClient(send, async () => {
    child.stdin.end();
    child.kill();
    await new Promise(r => child.once('exit', r));
  });
  client.child = child;
  await client.initialize();
  return client;
}

module.exports = { connectHttp, connectStdio, toolPayload, PROTOCOL_VERSION };

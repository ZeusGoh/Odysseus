/* protocol.js — a dependency-free MCP server core.

   Why not @modelcontextprotocol/sdk: this has to run on a Windows laptop whose
   Linux shell will not start, and later on whatever always-on box it ends up
   on. Every dependency is one more thing that has to install correctly
   somewhere Claude cannot reach to fix it. MCP's server side, for three
   read-only tools, is JSON-RPC 2.0 plus four methods — initialize,
   notifications/initialized, tools/list, tools/call — and ping. That is small
   enough to own outright, and owning it means `node server.js` works on a
   machine with no npm at all.

   Transports: newline-delimited JSON over stdio, and Streamable HTTP (POST,
   JSON response). Both speak the same core.
   part of Odysseus */

'use strict';

const http = require('http');

/*  Versions this server will negotiate, newest first. An unknown version from
    a client is answered with the newest we know, which is what the spec asks
    for — the client then decides whether it can live with it.               */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/* ---------- a small JSON Schema check ----------
   Only the subset the tool schemas here actually use. It exists so a bad
   argument comes back as a clean "window must be one of …" instead of a stack
   trace from somewhere inside the engine three calls later.                 */
function validate(schema, value, pathLabel) {
  const where = pathLabel || 'arguments';
  const errs = [];
  if (!schema || schema.type !== 'object') return errs;
  const v = value == null ? {} : value;
  if (typeof v !== 'object' || Array.isArray(v)) return [where + ' must be an object'];

  for (const key of schema.required || [])
    if (v[key] === undefined || v[key] === null || v[key] === '')
      errs.push(where + '.' + key + ' is required');

  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const got = v[key];
    if (got === undefined) continue;
    if (spec.type === 'string') {
      if (typeof got !== 'string') { errs.push(where + '.' + key + ' must be a string'); continue; }
      if (spec.enum && !spec.enum.includes(got))
        errs.push(where + '.' + key + ' must be one of ' + spec.enum.join(', ') + ' (got "' + got + '")');
      if (spec.maxLength && got.length > spec.maxLength)
        errs.push(where + '.' + key + ' is longer than ' + spec.maxLength + ' characters');
      if (spec.pattern && !new RegExp(spec.pattern).test(got))
        errs.push(where + '.' + key + ' does not look right (expected ' + spec.pattern + ')');
    } else if (spec.type === 'boolean') {
      if (typeof got !== 'boolean') errs.push(where + '.' + key + ' must be true or false');
    } else if (spec.type === 'number' || spec.type === 'integer') {
      if (typeof got !== 'number' || !isFinite(got)) errs.push(where + '.' + key + ' must be a number');
    }
  }

  if (schema.additionalProperties === false)
    for (const key of Object.keys(v))
      if (!(schema.properties || {})[key]) errs.push(where + '.' + key + ' is not a known argument');

  return errs;
}

/* ---------- the server core ---------- */

class McpServer {
  constructor(opts) {
    const o = opts || {};
    this.name = o.name || 'mcp-server';
    this.version = o.version || '0.0.0';
    this.instructions = o.instructions || undefined;
    this.log = o.log || (() => {});
    this.tools = new Map();
    this.initialized = false;
  }

  tool(def) {
    if (!def || !def.name || typeof def.handler !== 'function')
      throw new Error('a tool needs a name and a handler');
    this.tools.set(def.name, def);
    return this;
  }

  listTools() {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      title: t.title || undefined,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      annotations: t.annotations || undefined,
    }));
  }

  /*  Returns the JSON-RPC response object, or null for a notification (which
      gets no reply) — the transport decides what to do with it.             */
  async handle(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg))
      return errorFor(null, RPC.INVALID_REQUEST, 'a JSON-RPC message must be an object');
    if (msg.jsonrpc !== '2.0')
      return errorFor(msg.id, RPC.INVALID_REQUEST, 'jsonrpc must be "2.0"');

    const isNotification = msg.id === undefined || msg.id === null;
    if (typeof msg.method !== 'string')
      return isNotification ? null : errorFor(msg.id, RPC.INVALID_REQUEST, 'method is required');

    try {
      const result = await this._dispatch(msg.method, msg.params || {}, isNotification);
      if (isNotification) return null;
      return { jsonrpc: '2.0', id: msg.id, result: result === undefined ? {} : result };
    } catch (e) {
      if (isNotification) { this.log('notification ' + msg.method + ' failed: ' + e.message); return null; }
      const code = e.rpcCode || RPC.INTERNAL_ERROR;
      return errorFor(msg.id, code, e.message, e.rpcData);
    }
  }

  async _dispatch(method, params, isNotification) {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
          instructions: this.instructions,
        };
      }

      case 'notifications/initialized':
        this.initialized = true;
        return undefined;

      case 'notifications/cancelled':
        return undefined;

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: this.listTools() };

      case 'tools/call':
        return this._call(params);

      default:
        if (isNotification) return undefined;          // unknown notifications are ignored
        throw rpcError(RPC.METHOD_NOT_FOUND, 'unknown method: ' + method);
    }
  }

  async _call(params) {
    const name = params && params.name;
    const tool = this.tools.get(name);
    if (!tool) throw rpcError(RPC.METHOD_NOT_FOUND, 'unknown tool: ' + name);

    const args = params.arguments || {};
    const errs = validate(tool.inputSchema, args);
    if (errs.length) throw rpcError(RPC.INVALID_PARAMS, errs.join('; '));

    /*  A tool that fails is not a protocol failure. The spec wants the error
        handed back inside the result so the model can see it and react —
        "that symbol is not on the board" is information, not a crash.      */
    try {
      const out = await tool.handler(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
        isError: false,
      };
    } catch (e) {
      this.log('tool ' + name + ' failed: ' + (e && e.stack || e));
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(e && e.message || e), tool: name }, null, 2) }],
        isError: true,
      };
    }
  }
}

function rpcError(code, message, data) {
  const e = new Error(message);
  e.rpcCode = code;
  e.rpcData = data;
  return e;
}

function errorFor(id, code, message, data) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message, data } };
}

/* ---------- stdio transport ----------
   Newline-delimited JSON on stdin/stdout. NOTHING else may be written to
   stdout — a stray console.log corrupts the stream and the client simply
   disconnects with no useful error. All logging goes to stderr.            */
function serveStdio(server, opts) {
  const o = opts || {};
  const out = o.stdout || process.stdout;
  const inp = o.stdin || process.stdin;
  let buf = '';

  inp.setEncoding('utf8');
  inp.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      handleLine(line);
    }
  });

  async function handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) { return write(errorFor(null, RPC.PARSE_ERROR, 'invalid JSON: ' + e.message)); }
    const res = await server.handle(msg);
    if (res) write(res);
  }

  function write(obj) { out.write(JSON.stringify(obj) + '\n'); }

  return { close: () => inp.pause() };
}

/* ---------- Streamable HTTP transport ----------
   Stateless and request-scoped: every POST carries one JSON-RPC message and
   gets one JSON response. No SSE stream and no session id, because nothing
   here is long-running or server-initiated — which is exactly the shape a
   scheduled unattended run needs, since it cannot launch a subprocess.     */
function serveHttp(server, opts) {
  const o = opts || {};
  const port = o.port || 8787;
  const host = o.host || '127.0.0.1';
  const token = o.token || null;
  const endpoint = o.endpoint || '/mcp';
  const log = o.log || (() => {});

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    const json = (code, body, extra) => {
      const text = JSON.stringify(body);
      res.writeHead(code, Object.assign({
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      }, extra || {}));
      res.end(text);
    };

    if (url.pathname === '/health') return json(200, { ok: true, server: server.name, version: server.version });

    if (url.pathname !== endpoint) return json(404, { error: 'nothing here; the MCP endpoint is ' + endpoint });

    if (token) {
      const auth = req.headers.authorization || '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('token');
      if (given !== token)
        return json(401, errorFor(null, RPC.INVALID_REQUEST, 'a valid bearer token is required'),
                    { 'www-authenticate': 'Bearer' });
    }

    // GET would open an SSE stream in the full spec; this server has nothing
    // to push, and says so rather than hanging a connection open forever.
    if (req.method === 'GET')
      return json(405, errorFor(null, RPC.INVALID_REQUEST,
        'this server is POST-only — it has no server-initiated messages to stream'),
        { allow: 'POST' });

    if (req.method === 'DELETE') return json(200, { ok: true });   // stateless: nothing to tear down

    if (req.method !== 'POST')
      return json(405, errorFor(null, RPC.INVALID_REQUEST, 'use POST'), { allow: 'POST' });

    let body = '';
    let tooBig = false;
    req.on('data', c => {
      body += c;
      if (body.length > 1e6) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let msg;
      try { msg = JSON.parse(body); }
      catch (e) { return json(400, errorFor(null, RPC.PARSE_ERROR, 'invalid JSON: ' + e.message)); }

      try {
        // a batch is allowed by JSON-RPC; answer in kind
        if (Array.isArray(msg)) {
          const out = [];
          for (const m of msg) {
            const r = await server.handle(m);
            if (r) out.push(r);
          }
          return out.length ? json(200, out) : res.writeHead(202).end();
        }
        const r = await server.handle(msg);
        if (!r) return res.writeHead(202).end();       // it was a notification
        return json(200, r);
      } catch (e) {
        log('http handler failed: ' + (e && e.stack || e));
        return json(500, errorFor(msg && msg.id, RPC.INTERNAL_ERROR, String(e && e.message || e)));
      }
    });
  });

  return new Promise(resolve => {
    httpServer.listen(port, host, () => {
      resolve({
        port: httpServer.address().port,
        url: 'http://' + host + ':' + httpServer.address().port + endpoint,
        close: () => new Promise(r => httpServer.close(r)),
      });
    });
  });
}

module.exports = { McpServer, serveStdio, serveHttp, validate, PROTOCOL_VERSIONS, RPC };

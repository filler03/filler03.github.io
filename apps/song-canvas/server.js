'use strict';

/* Song Canvas backend
   POST /api/generate  -> queue an AI arrangement + render + Discord post
   GET  /api/job/:id   -> job status/result
   GET  /audio/:id.mp3 -> rendered audio
   GET  /health

   Runs behind nginx at /song-canvas/ (prefix stripped by nginx).
   Zero npm dependencies; reuses the deploy bot's opencode server. */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const ENGINE_SRC = path.join(ROOT, 'public/sandbox/song-canvas/proto-2/engine.js');
const RENDER_HTML = path.join(__dirname, 'render.html');
const BOT_DIR = process.env.DEPLOY_BOT_DIR || '/root/git-repos/Personal-Notes-Repo/deploy-bot-jf';
const PORT = Number(process.env.SONG_CANVAS_PORT || 3300);
const DATA_DIR = process.env.SONG_CANVAS_DATA || '/root/song-canvas-jobs';
const WORK_DIR = path.join(DATA_DIR, 'work');
const CHANNEL_ID = process.env.SONG_CANVAS_CHANNEL || '1566066965951553548';
const GUILD_ID = process.env.SONG_CANVAS_GUILD || '1512683536665149582';
const PROTO_URL = process.env.SONG_CANVAS_PROTO || 'https://filler03.duckdns.org/sandbox/song-canvas/proto-2/';
const PUBLIC_BASE = (process.env.SONG_CANVAS_PUBLIC || 'https://filler03.duckdns.org/song-canvas').replace(/\/+$/, '');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const AI_TIMEOUT_MS = Number(process.env.SONG_CANVAS_AI_TIMEOUT || 150000);
const RENDER_TIMEOUT_MS = Number(process.env.SONG_CANVAS_RENDER_TIMEOUT || 90000);
const JOB_COOLDOWN_MS = Number(process.env.SONG_CANVAS_COOLDOWN || 45000);
const MAX_BODY = 96 * 1024;

const PROGRESSIONS = ['bittersweet', 'dark', 'rising', 'floating', 'open', 'longing', 'hopeful', 'suspended', 'driving'];
const RIFFS = ['lullaby', 'spark', 'drive', 'sparse', 'hook', 'drift', 'pulse', 'weave', 'call', 'run'];
const INSTRUMENTS = ['pad', 'keys', 'strings', 'pluck', 'bells', 'bass', 'drums', 'perc'];
const FLOWS = ['blend', 'lift', 'drift'];

const jobs = new Map();
let running = null;
let lastStartAt = 0;
const ipLast = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = v => Math.round(clamp01(v) * 100) / 100;

function log(...a) { console.log(new Date().toISOString(), ...a); }

async function readEnv(file) {
  const env = {};
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch { return env; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

let botToken = null;
async function discordToken() {
  if (botToken) return botToken;
  const env = await readEnv(path.join(BOT_DIR, '.env'));
  botToken = process.env.DEPLOY_BOT_TOKEN || env.DISCORD_TOKEN;
  if (!botToken) throw new Error('No Discord token');
  return botToken;
}

function aiConfig() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(BOT_DIR, '.control-settings.json'), 'utf8'));
    return (s.ai && s.ai.model) || null;
  } catch { return null; }
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const bases = ['/root/.cache/puppeteer/chrome', '/root/.cache/ms-playwright'];
  for (const base of bases) {
    try {
      for (const dir of fs.readdirSync(base)) {
        for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const p = path.join(base, dir, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch { /* missing */ }
  }
  return null;
}
const CHROME = findChrome();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function run(file, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error(`${path.basename(file)} timed out`)); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} exited ${code}: ${err.slice(-300)}`));
    });
  });
}

/* ---------------- AI ---------------- */
function parseJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function instrumentObject(list, base) {
  const obj = {};
  for (const id of INSTRUMENTS) obj[id] = false;
  if (Array.isArray(list)) {
    for (const raw of list) {
      const id = String(raw).toLowerCase().trim();
      if (obj[id] !== undefined) obj[id] = true;
    }
  } else if (list && typeof list === 'object') {
    for (const id of INSTRUMENTS) obj[id] = !!list[id];
  } else if (base) {
    for (const id of INSTRUMENTS) obj[id] = !!base[id];
  }
  if (!INSTRUMENTS.some(id => obj[id])) obj.pad = true;
  return obj;
}

function sanitizeSection(raw, fallback, index) {
  const f = fallback || {};
  const name = String(raw && raw.name || f.name || `Moment ${index + 1}`).slice(0, 60);
  return {
    name,
    bars: Math.max(1, Math.min(16, Math.round(num(raw && raw.bars, f.bars || 4)))),
    pace: round2(num(raw && raw.pace, f.pace ?? 0.45)),
    energy: round2(num(raw && raw.energy, f.energy ?? 0.45)),
    brightness: round2(num(raw && raw.brightness, f.brightness ?? 0.5)),
    tension: round2(num(raw && raw.tension, f.tension ?? 0.3)),
    density: round2(num(raw && raw.density, f.density ?? 0.45)),
    space: round2(num(raw && raw.space, f.space ?? 0.4)),
    swing: round2(num(raw && raw.swing, f.swing ?? 0.1)),
    human: round2(num(raw && raw.human, f.human ?? 0.2)),
    progression: PROGRESSIONS.includes(raw && raw.progression) ? raw.progression : (f.progression || 'bittersweet'),
    riff: RIFFS.includes(raw && raw.riff) ? raw.riff : (f.riff || 'lullaby'),
    flow: FLOWS.includes(raw && raw.flow) ? raw.flow : (f.flow || 'blend'),
    instruments: instrumentObject(raw && raw.instruments, f.instruments)
  };
}

function sanitizeArrangement(obj, fallbackArrangement) {
  let list = obj && (obj.sections || obj.arrangement);
  if (!Array.isArray(list) || !list.length) list = fallbackArrangement;
  if (!Array.isArray(list) || !list.length) list = [];
  const sections = list.slice(0, 16).map((raw, i) => sanitizeSection(raw, null, i));
  if (!sections.length) throw new Error('No sections to render');
  return {
    title: String(obj && obj.title || 'Song Canvas piece').slice(0, 80),
    notes: String(obj && obj.notes || '').slice(0, 800),
    sections
  };
}

function buildAiPrompt(job) {
  const allowed = {
    progressions: PROGRESSIONS,
    riffs: RIFFS,
    instruments: INSTRUMENTS,
    flows: FLOWS
  };
  const system = [
    'You are the composer and arranger inside Song Canvas, a non-technical gesture music tool.',
    'You receive a sketch (sections, feels, players, optional notes) and must return ONE JSON object, no prose, no markdown.',
    'Start with a short evocative title ("title") and optional "notes", then the sections array.',
    'Compose a finished piece in A minor: 8-14 sections, explicitly including "Intro" and "Outro".',
    'Use the supplied feels as the emotional anchors, but write the transitions: lift, break, reprise, variation.',
    'Each section object MUST have:',
    'name (string), bars (1-16), pace (0-1), energy (0-1), brightness (0-1), tension (0-1), density (0-1), space (0-1),',
    'swing (0-1), human (0-1), progression (one of the allowed ids), riff (one of the allowed ids),',
    'flow (one of the allowed flows), instruments (array of allowed ids).',
    'Allowed IDs: ' + JSON.stringify(allowed),
    'Rules: keep total length roughly 60-120 seconds; keep each section musically coherent;',
    'do NOT use tools, do NOT read or write files, do NOT run commands. Output JSON only.'
  ].join('\n');
  const user = [
    'Sketch / commission:',
    JSON.stringify({
      brief: job.brief || '',
      notes: job.notes || '',
      sketch: job.spec,
      suggestedArrangement: job.arrangement
    }, null, 2),
    '',
    'Return the final arrangement JSON now.'
  ].join('\n');
  return { system, text: user };
}

async function composeWithAI(job) {
  const o = require(path.join(BOT_DIR, 'lib', 'opencode.js'));
  const model = aiConfig();
  const { system, text } = buildAiPrompt(job);
  const session = await o.createSession('Song Canvas: ' + (job.brief || job.title || 'sketch').slice(0, 60), WORK_DIR);
  job.sessionId = session && session.id;
  await o.promptAsync({
    sessionId: job.sessionId,
    text,
    system,
    model: model || undefined,
    directory: WORK_DIR
  });

  const deadline = Date.now() + AI_TIMEOUT_MS;
  let lastText = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(1800);
    let msgs = [];
    try { msgs = await o.sessionMessages(job.sessionId, 60, WORK_DIR) || []; } catch { continue; }
    const chunks = [];
    for (const m of msgs) {
      if (!m || !m.info || m.info.role !== 'assistant') continue;
      for (const p of m.parts || []) {
        if (p.type === 'text' && !p.synthetic && !p.ignored) chunks.push(p.text);
      }
    }
    const t = chunks.join('\n').trim();
    if (t && t === lastText) stable++;
    else { lastText = t; stable = 0; }
    const parsed = parseJson(t);
    if (parsed && Array.isArray(parsed.sections) && parsed.sections.length >= 4) {
      try { await o.deleteSession(job.sessionId, WORK_DIR); } catch { /* keep for debugging */ }
      return parsed;
    }
    if (stable >= 3 && t) {
      const obj = parseJson(t);
      if (obj) return obj;
    }
  }
  try { await o.abortSession(job.sessionId, WORK_DIR); } catch { /* ignore */ }
  throw new Error('AI timed out');
}

/* ---------------- render ---------------- */
function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch {} }
    });
    ws.onerror = () => reject(new Error('CDP socket error'));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        if (m.error) p.rej(new Error(m.error.message));
        else p.res(m.result);
        pending.delete(m.id);
      }
    };
  });
}

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(200);
  }
  throw new Error(`${label || 'timed out'}${lastErr ? ': ' + lastErr.message : ''}`);
}

async function renderChrome(items, job) {
  if (!CHROME) throw new Error('Chrome not found');
  const port = await freePort();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-chrome-'));
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  let client = null;
  try {
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      return r.ok;
    }, 20000, 'Chrome start');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('No page target');
    client = await cdpClient(page.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/render.html?job=${job.id}` });
    await waitFor(async () => {
      const r = await client.send('Runtime.evaluate', { expression: '!!(window.SongEngine && window.renderSpec)', returnByValue: true });
      return r && r.result && r.result.value;
    }, 20000, 'render harness');

    const call = await client.send('Runtime.evaluate', {
      expression: `renderSpec(${JSON.stringify(items)})`,
      returnByValue: true,
      awaitPromise: true
    });
    if (call.exceptionDetails) throw new Error(call.exceptionDetails.exception?.description || 'render failed');
    const meta = call.result.value || {};
    const size = await client.send('Runtime.evaluate', { expression: 'window.__wav.length', returnByValue: true });
    const total = size.result.value;
    if (!total) throw new Error('No audio produced');

    const CH = 384 * 1024;
    const bufs = [];
    for (let off = 0; off < total; off += CH) {
      const len = Math.min(CH, total - off);
      const r = await client.send('Runtime.evaluate', {
        expression: `(() => { const u = window.__wav.subarray(${off}, ${off + len}); let s=''; for (let i=0;i<u.length;i+=0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i+0x8000)); return btoa(s); })()`,
        returnByValue: true
      });
      bufs.push(Buffer.from(r.result.value, 'base64'));
    }
    const wav = Buffer.concat(bufs);
    const wavPath = path.join(DATA_DIR, `${job.id}.wav`);
    await fsp.writeFile(wavPath, wav);
    return { wavPath, duration: meta.duration || 0, bytes: wav.length };
  } finally {
    if (client) client.close();
    try { proc.kill('SIGKILL'); } catch {}
    setTimeout(() => { fsp.rm(profile, { recursive: true, force: true }).catch(() => {}); }, 500);
  }
}

/* ---------------- Discord ---------------- */
async function postToDiscord(job, mp3Path, result) {
  const token = await discordToken();
  const minutes = Math.floor((result.duration || 0) / 60);
  const seconds = Math.round((result.duration || 0) % 60);
  const names = result.items.map(s => s.name).slice(0, 16).join(' → ');
  const content = [
    '🎵 **Song Canvas render**',
    job.brief ? '> ' + job.brief.slice(0, 400) : '> (no brief)',
    '',
    `**${result.title || 'Untitled'}** · ${minutes}:${String(seconds).padStart(2, '0')} · ${result.source === 'ai' ? 'arranged by opencode' : 'local fallback (AI failed)'} · ${result.items.length} sections`,
    names,
    result.source === 'ai' ? `model: \`${result.model || 'default'}\`` : `AI error: ${result.aiError || 'unknown'}`,
    `prototype: ${PROTO_URL}`
  ].join('\n');

  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }));
  form.append('files[0]', new Blob([await fsp.readFile(mp3Path)], { type: 'audio/mpeg' }), `song-canvas-${job.id.slice(0, 8)}.mp3`);
  const specJson = JSON.stringify({ brief: job.brief, notes: job.notes, spec: result.items, source: result.source, model: result.model }, null, 2);
  form.append('files[1]', new Blob([specJson], { type: 'application/json' }), `song-canvas-${job.id.slice(0, 8)}.json`);

  const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}` },
    body: form
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Discord ${res.status}: ${body.message || 'upload failed'}`);
  return {
    messageId: body.id,
    url: `https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${body.id}`
  };
}

/* ---------------- job ---------------- */
function updateJob(job, patch) { Object.assign(job, patch); }

async function processJob(job) {
  const started = Date.now();
  try {
    updateJob(job, { status: 'composing', phase: 'opencode is arranging the song' });
    let ai = null;
    let aiError = null;
    try { ai = await composeWithAI(job); }
    catch (e) { aiError = e.message; log('AI failed', job.id, e.message); }

    const fallback = job.arrangement && job.arrangement.length ? job.arrangement : job.spec && job.spec.sections;
    let final;
    let source = 'fallback';
    if (ai) {
      try {
        final = sanitizeArrangement(ai, fallback);
        source = 'ai';
      } catch (e) {
        aiError = e.message;
        final = sanitizeArrangement(null, fallback);
      }
    } else {
      final = sanitizeArrangement(null, fallback);
    }
    updateJob(job, { title: final.title, source, aiError, arrangementFinal: final.sections });

    updateJob(job, { status: 'rendering', phase: 'rendering the arrangement' });
    const rendered = await renderChrome(final.sections, job);

    updateJob(job, { status: 'encoding', phase: 'encoding the audio' });
    const mp3Path = path.join(DATA_DIR, `${job.id}.mp3`);
    await run(FFMPEG, ['-y', '-i', rendered.wavPath, '-c:a', 'libmp3lame', '-b:a', '192k', mp3Path], 60000);

    updateJob(job, { status: 'posting', phase: 'posting to #music-testing' });
    const result = {
      title: final.title,
      items: final.sections,
      source,
      model: aiConfig() ? `${aiConfig().providerID}/${aiConfig().modelID}` : 'default',
      aiError,
      duration: rendered.duration
    };
    const discord = await postToDiscord(job, mp3Path, result);

    updateJob(job, {
      status: 'done',
      phase: 'done',
      duration: rendered.duration,
      audioUrl: `${PUBLIC_BASE}/audio/${job.id}.mp3`,
      discordUrl: discord.url,
      model: result.model,
      elapsedMs: Date.now() - started
    });
    log('done', job.id, result.source, rendered.duration.toFixed(1) + 's', discord.url);
  } catch (e) {
    log('job error', job.id, e.message);
    updateJob(job, { status: 'error', phase: 'failed', error: e.message, elapsedMs: Date.now() - started });
  } finally {
    running = null;
    pump();
  }
}

function pump() {
  if (running) return;
  const next = [...jobs.values()].find(j => j.status === 'queued');
  if (!next) return;
  running = next.id;
  processJob(next);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    title: job.title,
    source: job.source,
    model: job.model,
    duration: job.duration,
    audioUrl: job.audioUrl,
    discordUrl: job.discordUrl,
    error: job.error,
    aiError: job.aiError,
    elapsedMs: job.elapsedMs,
    sections: job.arrangementFinal ? job.arrangementFinal.length : undefined
  };
}

/* ---------------- HTTP ---------------- */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

async function serveFile(res, file, type, cache = 'no-store') {
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': type, 'cache-control': cache });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname.startsWith('/song-canvas')) pathname = pathname.slice('/song-canvas'.length) || '/';

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  try {
    if (pathname === '/health') {
      return json(res, 200, {
        ok: true,
        jobs: jobs.size,
        running,
        chrome: !!CHROME,
        endpoint: PUBLIC_BASE,
        time: new Date().toISOString()
      });
    }

    if (pathname === '/render.html') return serveFile(res, RENDER_HTML, 'text/html; charset=utf-8');
    if (pathname === '/engine.js') return serveFile(res, ENGINE_SRC, 'application/javascript; charset=utf-8');

    if (req.method === 'POST' && pathname === '/api/generate') {
      const ip = clientIp(req);
      const now = Date.now();
      if (now - lastStartAt < JOB_COOLDOWN_MS) {
        return json(res, 429, { error: 'The composer is cooling down. Try again shortly.', retryAfter: Math.ceil((JOB_COOLDOWN_MS - (now - lastStartAt)) / 1000) });
      }
      const last = ipLast.get(ip) || 0;
      if (now - last < 120000) {
        return json(res, 429, { error: 'One song request every two minutes.', retryAfter: Math.ceil((120000 - (now - last)) / 1000) });
      }
      const queued = [...jobs.values()].filter(j => j.status === 'queued').length;
      if (queued >= 2) return json(res, 429, { error: 'The queue is full — try again in a minute.' });
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); }
      catch (e) { return json(res, 400, { error: 'Invalid JSON: ' + e.message }); }
      if (!body || !body.spec || !Array.isArray(body.spec.sections)) {
        return json(res, 400, { error: 'Send the Song Canvas commission: { brief, spec, arrangement }.' });
      }
      const id = crypto.randomBytes(6).toString('hex');
      const job = {
        id,
        createdAt: now,
        status: 'queued',
        phase: 'waiting for the composer',
        brief: String(body.brief || '').slice(0, 2000),
        notes: String(body.notes || '').slice(0, 2000),
        spec: body.spec,
        arrangement: Array.isArray(body.arrangement) ? body.arrangement : [],
        title: 'Song Canvas piece'
      };
      jobs.set(id, job);
      ipLast.set(ip, now);
      lastStartAt = now;
      if (jobs.size > 60) {
        const done = [...jobs.values()].filter(j => j.status === 'done' || j.status === 'error').slice(0, jobs.size - 60);
        for (const j of done) jobs.delete(j.id);
      }
      log('queued', id, ip, (job.brief || '').slice(0, 60));
      pump();
      return json(res, 202, { jobId: id, status: job.status });
    }

    const mJob = pathname.match(/^\/api\/job\/([a-f0-9]{6,32})$/);
    if (req.method === 'GET' && mJob) {
      const job = jobs.get(mJob[1]);
      if (!job) return json(res, 404, { error: 'Unknown job' });
      return json(res, 200, publicJob(job));
    }

    const mAudio = pathname.match(/^\/audio\/([a-f0-9]{6,32})\.mp3$/);
    if (req.method === 'GET' && mAudio) {
      const file = path.join(DATA_DIR, `${mAudio[1]}.mp3`);
      return serveFile(res, file, 'audio/mpeg', 'public, max-age=86400');
    }

    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Song Canvas backend</title><body style="font:16px system-ui;background:#0b0c12;color:#eceaf5;padding:40px"><h1>Song Canvas backend</h1><p>POST <code>/api/generate</code> · GET <code>/api/job/:id</code> · audio at <code>/audio/:id.mp3</code></p><p>' + (CHROME ? 'renderer ready' : 'renderer unavailable') + '</p></body>');
      return;
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log('http error', e.message);
    return json(res, 500, { error: e.message });
  }
});

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(WORK_DIR, { recursive: true });
  server.listen(PORT, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${PORT} · channel ${CHANNEL_ID} · chrome ${CHROME || 'missing'}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DouyinLive } from './douyin/client.js';
import { VoiceQueue } from './voice.js';
import { ScoreBoard } from './scores.js';
import { config, saveConfig } from './config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

const history = [];
const clients = new Set();
const seenChatters = new Set();
let live = null;
let lastJoinAt = 0;

const voice = new VoiceQueue({
  voice: config.voiceName || 'Microsoft Huihui Desktop',
  rate: Number(config.voiceRate) || 0,
});
voice.setEnabled(config.voice !== false);

const scores = new ScoreBoard();

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function pushHistory(message) {
  history.push(message);
  if (history.length > 40) history.shift();
}

function speakable(text, limit = 60) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function currentState() {
  return {
    roomId: config.roomId,
    roundSeconds: config.roundSeconds,
    voice: config.voice !== false,
    clients: clients.size,
    live: live ? live.state : { phase: 'idle', lastError: null },
  };
}

function broadcastState() {
  broadcast({ type: 'status', state: currentState() });
}

function broadcastTotals() {
  broadcast({ type: 'totals', ...scores.snapshot() });
}

function announceJoin(message) {
  if (config.voice === false) return;
  const uid = String(message.uid || message.nickname || '');
  if (!uid || seenChatters.has(uid)) return;
  const at = Date.now();
  if (at - lastJoinAt < 2500) return;
  lastJoinAt = at;
  seenChatters.add(uid);
  const name = speakable(message.nickname || '观众', 16) || '观众';
  voice.enqueue(`欢迎 ${name} 加入闯关`, 'join');
}

function announceEnter(message) {
  if (config.voice === false) return;
  const uid = String(message.uid || '');
  if (!uid || seenChatters.has(uid)) return;
  const at = Date.now();
  if (at - lastJoinAt < 2500) return;
  lastJoinAt = at;
  seenChatters.add(uid);
  const name = speakable(message.nickname || '观众', 16) || '观众';
  voice.enqueue(`欢迎 ${name} 进入直播间，发弹幕就能上车`, 'join');
}

function handleChat(message) {
  const event = { type: 'chat', ...message };
  pushHistory(event);
  broadcast(event);
  announceJoin(message);
}

voice.on('ready', (item) => broadcast({ type: 'voice', ...item }));
voice.on('error', (err) => console.error('语音合成失败', err.message));

function wireLive(instance) {
  instance.on('chat', handleChat);
  instance.on('like', (message) => broadcast({ type: 'like', ...message }));
  instance.on('gift', (message) => broadcast({ type: 'gift', ...message }));
  instance.on('member', (message) => {
    broadcast({ type: 'member', ...message });
    announceEnter(message);
  });
  instance.on('status', () => broadcastState());
  instance.on('log', (level, message) => {
    console.log(`[${level}] ${message}`);
    broadcast({ type: 'log', level, message });
  });
}

async function switchRoom(roomId) {
  const next = String(roomId ?? '').trim();
  if (live) {
    live.stop();
    live = null;
  }
  seenChatters.clear();
  lastJoinAt = 0;
  voice.clear();
  saveConfig({ roomId: next });
  if (next) scores.setRoom(next);
  broadcastTotals();
  if (next) {
    live = new DouyinLive(next);
    wireLive(live);
    live.start().catch((err) => console.error('启动弹幕连接失败', err));
  }
  broadcastState();
  return currentState();
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, currentState());
  }

  if (url.pathname === '/api/room' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const state = await switchRoom(body.roomId);
      return sendJson(res, 200, state);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/voice' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      saveConfig({ voice: Boolean(body.enabled) });
      voice.setEnabled(config.voice);
      broadcastState();
      return sendJson(res, 200, currentState());
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (url.pathname === '/api/dev/event' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ts = Date.now();
      const nickname = String(body.nickname ?? '测试观众');
      const uid = String(body.uid ?? `dev-${nickname}`);
      const type = String(body.type ?? 'chat');
      if (type === 'like') {
        broadcast({ type: 'like', uid, nickname, count: Number(body.count ?? 5), total: 0, ts });
      } else if (type === 'gift') {
        broadcast({ type: 'gift', uid, nickname, giftName: String(body.giftName ?? '小心心'), count: Number(body.count ?? 1), diamond: 1, ts });
      } else {
        handleChat({ uid, nickname, content: String(body.content ?? '加入'), ts });
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  let filePath = path.join(publicDir, url.pathname === '/' ? 'host.html' : url.pathname);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!path.extname(filePath)) filePath += '.html';
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    res.writeHead(404);
    return res.end('Not Found');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', state: currentState(), history, totals: scores.snapshot() }));
  broadcastState();
  ws.on('message', (raw) => {
    if (String(raw).length > 4000) return;
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg?.type === 'round-result') {
      // 同时开着预览和 OBS 时只让最早接入的画面记分，避免总榜重复累加
      if ([...clients][0] !== ws) return;
      if (scores.addRound(Array.isArray(msg.players) ? msg.players.slice(0, 40) : [])) {
        broadcastTotals();
      }
      return;
    }
    if (msg?.type !== 'speak' || config.voice === false) return;
    const text = speakable(msg.text);
    if (text) voice.enqueue(text, 'result');
  });
  ws.on('close', () => {
    clients.delete(ws);
    broadcastState();
  });
  ws.on('error', () => clients.delete(ws));
});

server.listen(config.port, () => {
  console.log(`控制台: http://127.0.0.1:${config.port}/host`);
  console.log(`直播画面: http://127.0.0.1:${config.port}/overlay`);
  if (config.roomId) {
    switchRoom(config.roomId);
  } else {
    console.log('未配置直播间号，请在控制台填写');
  }
});

process.on('SIGINT', () => {
  live?.stop();
  process.exit(0);
});

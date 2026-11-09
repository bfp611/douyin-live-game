const W = 1080;
const H = 1920;
const GROUND = 1400;
const PANEL_TOP = 1540;
const MAX_CHARS = 30;
const GRAVITY = 2900;
const JUMP_V = 1500;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let viewScale = 1;
let viewX = 0;
let viewY = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  viewScale = Math.min(window.innerWidth / W, window.innerHeight / H);
  viewX = (window.innerWidth - W * viewScale) / 2;
  viewY = (window.innerHeight - H * viewScale) / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

const now = () => performance.now() / 1000;

const state = {
  phase: 'running',
  round: 1,
  elapsed: 0,
  roundSeconds: 75,
  chars: new Map(),
  obstacles: [],
  coins: [],
  particles: [],
  floats: [],
  feed: [],
  toasts: [],
  giftBanner: null,
  likes: 0,
  likeEnergy: 0,
  online: 0,
  surgeUntil: 0,
  speed: 300,
  camera: 0,
  spawnClock: 0,
  coinClock: 0,
  lastSecond: 0,
  result: null,
  connected: false,
  voiceOn: true,
  voiceUntil: 0,
  lastChatAt: 0,
  roomTitle: '',
  resultResetAt: 0,
  totals: { date: '', top: [] },
};

const roundParam = Number(new URLSearchParams(location.search).get('round'));
const roundOverride = Number.isFinite(roundParam) && roundParam >= 5;
if (roundOverride) state.roundSeconds = roundParam;

const AI_NAMES = [
  ['ai-xiaopao', '小跑'],
  ['ai-shandian', '闪电'],
  ['ai-doudou', '豆豆'],
];

// ---------- helpers ----------
function hashOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function colorOf(uid) {
  const h = hashOf(uid) % 360;
  return `hsl(${h} 78% 63%)`;
}

function darken(hsl, amount = 14) {
  return hsl.replace(/(\d+)%\)$/, (_, l) => `${Math.max(18, Number(l) - amount)}%)`);
}

function rr(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function pill(x, y, w, h, fill, stroke) {
  rr(x, y, w, h, h / 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function truncate(text, maxWidth, font) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function formatCount(n) {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function spawnParticles(x, y, count, palette, opts = {}) {
  const speed = opts.speed ?? 260;
  for (let i = 0; i < count; i++) {
    const angle = opts.angle != null ? opts.angle + (Math.random() - 0.5) * 1.2 : Math.random() * Math.PI * 2;
    const v = speed * (0.35 + Math.random());
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * v,
      vy: Math.sin(angle) * v - (opts.lift ?? 80),
      life: 0,
      ttl: opts.ttl ?? 0.9 + Math.random() * 0.7,
      size: opts.size ?? 3 + Math.random() * 4,
      color: palette[Math.floor(Math.random() * palette.length)],
      gravity: opts.gravity ?? 900,
      shape: Math.random() < 0.3 ? 'rect' : 'circle',
    });
  }
}

function addFloat(x, y, text, color) {
  state.floats.push({ x, y, text, color, life: 0, ttl: 1.2 });
}

function addToast(text) {
  state.toasts.push({ text, until: now() + 2.6 });
  if (state.toasts.length > 3) state.toasts.shift();
}

function addFeed(nick, content, color) {
  state.feed.push({ nick, content, color, t: now() });
  if (state.feed.length > 40) state.feed.shift();
}

// ---------- characters ----------
function pickSpawnX(uid) {
  const span = 760;
  let x = 140 + (hashOf(uid) % span);
  const taken = [...state.chars.values()].map((c) => c.x);
  for (let i = 0; i < 8 && taken.some((v) => Math.abs(v - x) < 120); i++) {
    x = 140 + ((x - 140 + 110) % span);
  }
  return x;
}

function newCharacter(uid, nick, isAI) {
  const hash = hashOf(uid);
  return {
    uid,
    nick,
    isAI,
    color: colorOf(uid),
    x: pickSpawnX(uid),
    y: GROUND,
    vy: 0,
    onGround: true,
    scale: 0.88 + (hash % 5) * 0.035,
    phase: (hash % 100) / 100 * Math.PI * 2,
    score: 0,
    combo: 0,
    jumpTickets: 0,
    joinedAt: now(),
    lastActive: now(),
    labelUntil: now() + 4,
    shieldUntil: 0,
    boostUntil: 0,
    giftUntil: 0,
    tumbleUntil: 0,
    tumbleSeed: hash % 10,
    lastJumpCmd: 0,
    lastBoostCmd: 0,
    lastShieldCmd: 0,
  };
}

function addAICompanions() {
  AI_NAMES.forEach(([uid, nick]) => {
    const c = newCharacter(uid, nick, true);
    c.labelUntil = 0;
    state.chars.set(uid, c);
  });
}

function joinCharacter(uid, nick, isAI = false) {
  const existing = state.chars.get(uid);
  if (existing) return existing;
  if (state.chars.size >= MAX_CHARS) {
    const victim = [...state.chars.values()]
      .filter((c) => !c.isAI)
      .sort((a, b) => a.score - b.score || a.lastActive - b.lastActive)[0];
    if (victim && now() - victim.lastActive > 45) {
      state.chars.delete(victim.uid);
    } else {
      addToast('本局满员，下一轮再来～');
      return null;
    }
  }
  const c = newCharacter(uid, nick, isAI);
  state.chars.set(uid, c);
  spawnParticles(c.x, GROUND - 40, 16, [c.color, '#ffd166', '#fff'], { speed: 220, lift: 120 });
  addFloat(c.x, GROUND - 120, '加入！', '#ffd166');
  if (!isAI) addToast(`「${truncate(nick, 140, '20px sans-serif')}」加入了闯关`);
  return c;
}

function jump(c) {
  if (!c.onGround || now() < c.tumbleUntil) return false;
  c.vy = -JUMP_V;
  c.onGround = false;
  spawnParticles(c.x, GROUND, 7, ['#c9b8ff', '#ffffff'], { speed: 120, lift: 40, ttl: 0.4, size: 2.5 });
  return true;
}

function crash(c, reason) {
  const t = now();
  if (t < c.shieldUntil || t < c.boostUntil) return;
  if (t < c.tumbleUntil) return;
  c.tumbleUntil = t + 1.05;
  c.combo = 0;
  c.score = Math.max(0, c.score - 20);
  c.y = GROUND;
  c.vy = 0;
  c.onGround = true;
  if (!c.isAI) {
    c.labelUntil = t + 1.5;
    addFloat(c.x, GROUND - 110, reason, '#ff8a8a');
    addFloat(c.x, GROUND - 152, '发「跳」越过', '#9be7ff');
  }
  spawnParticles(c.x, GROUND - 40, 14, ['#ff6b6b', '#ffd166'], { speed: 200, lift: 110 });
}

// ---------- danmaku handling ----------
function normalizeText(s) {
  return String(s)
    .replace(/\[[^\]]{1,10}\]/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

const CMD = {
  join: /(加入|上车|我来|报名|带我|来啦|来了|开始吧|带我玩)/,
  boost: /(冲|加速|冲刺|快跑|rush|biu|起飞|疾跑)/,
  jump: /(跳|蹦|jump)/,
  shield: /(护|盾|保护|保命|庇护|安全)/,
  cheer: /(666|加油|牛|棒|哈哈|帅|厉害|好看|可以)/,
};

function onChat(m, replay = false) {
  const t = now();
  const nick = m.nickname || '观众';
  const uid = m.uid || `u-${nick}`;
  const content = String(m.content ?? '').slice(0, 40);
  addFeed(nick, content, colorOf(uid));

  let c = state.chars.get(uid);
  if (!c) c = joinCharacter(uid, nick, false);
  if (!c) return;
  if (String(uid).startsWith('sim-')) c.sim = true;

  c.lastActive = t;
  c.labelUntil = Math.max(c.labelUntil, t + 2.4);
  if (replay) return;
  state.lastChatAt = t;

  const text = normalizeText(content);
  const mult = 1 + Math.min(20, c.combo) * 0.05;

  if (CMD.join.test(text)) {
    c.score += 8;
    addFloat(c.x, GROUND - 100, '已上车', '#8ef0c0');
    return;
  }
  if (CMD.boost.test(text)) {
    if (t - c.lastBoostCmd < 3.5) return;
    c.lastBoostCmd = t;
    c.boostUntil = t + 2.2;
    c.score += Math.round(60 * mult);
    addFloat(c.x, GROUND - 130, '加速！', '#ffd166');
    spawnParticles(c.x, GROUND - 50, 18, ['#ffd166', '#ff9f1c', '#fff'], { speed: 260, lift: 80 });
    return;
  }
  if (CMD.jump.test(text)) {
    if (t - c.lastJumpCmd < 0.35) return;
    c.lastJumpCmd = t;
    c.score += Math.round(12 * mult);
    const full = c.jumpTickets >= 3;
    c.jumpTickets = Math.min(3, c.jumpTickets + 1);
    addFloat(c.x, GROUND - 140, full ? '蓄力已满' : `蓄力 ×${c.jumpTickets}`, '#9be7ff');
    for (const mate of state.chars.values()) {
      if (mate.isAI) mate.jumpTickets = Math.min(3, mate.jumpTickets + 1);
    }
    return;
  }
  if (CMD.shield.test(text)) {
    if (t - c.lastShieldCmd < 8) return;
    c.lastShieldCmd = t;
    c.shieldUntil = t + 6;
    c.score += Math.round(30 * mult);
    addFloat(c.x, GROUND - 130, '护盾', '#ffd166');
    return;
  }
  if (CMD.cheer.test(text)) {
    c.score += Math.round(15 * mult);
    c.combo += 1;
    addFloat(c.x, GROUND - 120, `+${Math.round(15 * mult)}`, '#8ef0c0');
    return;
  }
  c.score += Math.round(6 * mult);
  addFloat(c.x, GROUND - 110, '+6', '#b9aed0');
}

function onLike(m) {
  const count = Math.max(1, Number(m.count) || 1);
  state.likes += count;
  state.likeEnergy += count;
  if (state.likeEnergy >= 130) {
    state.likeEnergy = 0;
    triggerSurge();
  }
}

function triggerSurge() {
  state.surgeUntil = now() + 8;
  addToast('全场加速！点赞冲起来！');
  const colors = ['#ffd166', '#ff6b6b', '#4ecdc4', '#a78bfa', '#ffffff'];
  for (let i = 0; i < 5; i++) {
    spawnParticles(140 + Math.random() * (W - 280), 200 + Math.random() * 220, 26, colors, {
      speed: 320,
      lift: 40,
      ttl: 1.4,
      size: 4,
    });
  }
  for (const c of state.chars.values()) {
    c.score += 15;
    addFloat(c.x, GROUND - 120, '+15', '#ffd166');
  }
}

function onGift(m) {
  const t = now();
  const uid = m.uid || `g-${m.nickname}`;
  let c = state.chars.get(uid);
  if (!c) c = joinCharacter(uid, m.nickname || '观众', false);
  const giftName = m.giftName || '礼物';
  const count = Math.max(1, Number(m.count) || 1);
  state.giftBanner = {
    nick: m.nickname || '观众',
    gift: giftName,
    count,
    until: t + 5,
  };
  if (c) {
    c.score += 300 * Math.min(5, count);
    c.shieldUntil = t + 8;
    c.giftUntil = t + 5;
    c.labelUntil = t + 5;
    addFloat(c.x, GROUND - 150, `礼物 +${300 * Math.min(5, count)}`, '#ffd166');
    spawnParticles(c.x, GROUND - 60, 30, ['#ffd166', '#ff6b6b', '#4ecdc4', '#fff'], { speed: 340, lift: 160 });
  }
  addToast(`感谢「${m.nickname || '观众'}」送出的 ${giftName}！`);
}

function onMember(m) {
  if (m.audience) state.online = Math.max(state.online, Number(m.audience) || 0);
}

// ---------- game update ----------
function spawnObstacle() {
  const roll = Math.random();
  let type = 'crate';
  if (roll > 0.72) type = 'gap';
  else if (roll > 0.42) type = 'spike';
  const widths = { crate: 58, spike: 74, gap: 150 };
  const heights = { crate: 66, spike: 50, gap: 0 };
  state.obstacles.push({
    id: `o-${Math.random().toString(36).slice(2, 9)}`,
    type,
    x: W + 120,
    w: widths[type],
    h: heights[type],
    cleared: new Set(),
  });
}

function spawnCoins() {
  const baseX = W + 220;
  const n = 5;
  for (let i = 0; i < n; i++) {
    state.coins.push({
      id: `c-${Math.random().toString(36).slice(2, 9)}`,
      x: baseX + i * 56,
      y: GROUND - 120 - Math.sin((i / (n - 1)) * Math.PI) * 80,
      taken: new Set(),
      spin: Math.random() * 6,
    });
  }
}

function update(dt, t) {
  const progress = Math.min(1, state.elapsed / state.roundSeconds);
  const surge = t < state.surgeUntil;
  const targetSpeed = (300 + 70 * progress) * (surge ? 1.35 : 1);
  state.speed += (targetSpeed - state.speed) * Math.min(1, dt * 3);
  state.camera += state.speed * dt;

  if (state.phase === 'running') {
    state.elapsed += dt;
    state.spawnClock += dt;
    state.coinClock += dt;

    const gap = (360 + Math.random() * 240) / state.speed;
    if (state.spawnClock >= gap) {
      state.spawnClock = 0;
      spawnObstacle();
    }
    if (state.coinClock > 5.5) {
      state.coinClock = 0;
      if (Math.random() < 0.7) spawnCoins();
    }

    if (state.elapsed >= state.roundSeconds) endRound(t);
  } else if (state.phase === 'result' && t >= state.resultResetAt) {
    startRound(t);
  }

  if (state.phase === 'running') {
    for (const obs of state.obstacles) obs.x -= state.speed * dt;
    for (const coin of state.coins) coin.x -= state.speed * dt;

    const activeObstacles = state.obstacles.filter((o) => o.x + o.w > -160);
    state.obstacles = activeObstacles;
    state.coins = state.coins.filter((c) => c.x > -160);

    for (const c of state.chars.values()) {
      updateChar(c, dt, t, activeObstacles);
    }
  }

  for (const p of state.particles) {
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += p.gravity * dt;
    p.vx *= 0.99;
  }
  state.particles = state.particles.filter((p) => p.life < p.ttl);

  for (const f of state.floats) {
    f.life += dt;
    f.y -= 46 * dt;
  }
  state.floats = state.floats.filter((f) => f.life < f.ttl);

  state.toasts = state.toasts.filter((x) => x.until > t);
  state.feed = state.feed.filter((f) => t - f.t < 30);
  if (state.giftBanner && state.giftBanner.until < t) state.giftBanner = null;

  if (state.phase === 'running' && Math.floor(state.elapsed) !== state.lastSecond) {
    state.lastSecond = Math.floor(state.elapsed);
    for (const c of state.chars.values()) {
      c.score += 6;
    }
  }

  // 长时间不互动的观众让位（保留 AI）
  for (const c of state.chars.values()) {
    if (!c.isAI && t - c.lastActive > 300) state.chars.delete(c.uid);
  }

  maybeHostTalk(t);
}

function updateChar(c, dt, t, obstacles) {
  if (t < c.tumbleUntil) {
    c.y = GROUND;
    c.vy = 0;
    c.onGround = true;
    return;
  }

  if (!c.onGround) {
    c.vy += GRAVITY * dt;
    c.y += c.vy * dt;
    if (c.y >= GROUND) {
      c.y = GROUND;
      c.vy = 0;
      c.onGround = true;
    }
  }

  // 攒了「跳」的角色，在安全距离自动起跳
  if (c.jumpTickets > 0 && c.onGround) {
    const next = obstacles
      .filter((o) => o.x > c.x + 30)
      .sort((a, b) => a.x - b.x)[0];
    if (next) {
      const trigger = 0.98 * state.speed - next.w - 24;
      if (next.x - c.x <= trigger && jump(c)) {
        c.jumpTickets -= 1;
        addFloat(c.x, GROUND - 150, '跳！', '#9be7ff');
      }
    }
  }

  // 碰撞
  for (const o of obstacles) {
    if (o.x > c.x + 40 || o.x + o.w < c.x - 40) continue;
    if (t < c.shieldUntil || t < c.boostUntil) continue;

    if (o.type === 'gap') {
      if (c.onGround && c.x > o.x + 6 && c.x < o.x + o.w - 6) {
        crash(c, '掉坑了');
      }
    } else if (c.onGround && c.y > GROUND - o.h - 8) {
      const overlap = c.x + 16 > o.x && c.x - 16 < o.x + o.w;
      if (overlap) crash(c, '撞到了');
    }
  }

  // 通过奖励
  for (const o of obstacles) {
    if (o.x + o.w < c.x && !o.cleared.has(c.uid)) {
      o.cleared.add(c.uid);
      if (t >= c.tumbleUntil) {
        c.combo = Math.min(99, c.combo + 1);
        const gain = Math.round(10 * (1 + Math.min(20, c.combo) * 0.05));
        c.score += gain;
        if (c.combo % 5 === 0) {
          addFloat(c.x, GROUND - 130, `连击 x${c.combo}`, '#ffd166');
          c.labelUntil = t + 2;
        }
      }
    }
  }

  // 金币
  for (const coin of state.coins) {
    if (coin.taken.has(c.uid)) continue;
    const bodyY = c.y - 34;
    if (Math.abs(coin.x - c.x) < 38 && Math.abs(coin.y - bodyY) < 140) {
      coin.taken.add(c.uid);
      c.score += 15;
      addFloat(coin.x, coin.y - 10, '+15', '#ffd166');
      spawnParticles(coin.x, coin.y, 6, ['#ffd166', '#fff'], { speed: 130, lift: 20, ttl: 0.45, size: 2.5 });
    }
  }

}

function endRound(t) {
  state.phase = 'result';
  state.resultResetAt = t + 6;
  const ranked = [...state.chars.values()]
    .filter((c) => !c.isAI)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((c) => ({ nick: c.nick, score: Math.floor(c.score), color: c.color }));
  state.result = {
    ranked,
    round: state.round,
    until: state.resultResetAt,
  };
  announceWinners(ranked, state.round);
  sendRoundResult();
  for (const c of state.chars.values()) {
    c.labelUntil = t + 6;
    c.y = GROUND;
    c.vy = 0;
    c.onGround = true;
  }
  const colors = ['#ffd166', '#ff6b6b', '#4ecdc4', '#a78bfa', '#ffffff'];
  for (let i = 0; i < 6; i++) {
    spawnParticles(140 + Math.random() * (W - 280), 300 + Math.random() * 320, 30, colors, {
      speed: 380,
      lift: 30,
      ttl: 1.6,
      size: 4,
    });
  }
}

function startRound(t) {
  state.phase = 'running';
  state.elapsed = 0;
  state.round += 1;
  state.lastSecond = 0;
  state.speed = 300;
  state.surgeUntil = 0;
  state.obstacles = [];
  state.coins = [];
  state.result = null;
  state.spawnClock = 0;
  state.coinClock = 0;
  for (const c of state.chars.values()) {
    c.score = 0;
    c.combo = 0;
    c.jumpTickets = 0;
    c.y = GROUND;
    c.vy = 0;
    c.onGround = true;
    c.tumbleUntil = 0;
    c.shieldUntil = 0;
    c.boostUntil = 0;
    c.giftUntil = 0;
    c.lastActive = t;
  }
  addToast(`第 ${state.round} 轮开始！发任意弹幕就能上车`);
}

// ---------- rendering ----------
function drawBackground(t) {
  const g = ctx.createLinearGradient(0, 0, 0, GROUND);
  g.addColorStop(0, '#0d0920');
  g.addColorStop(0.45, '#2a1642');
  g.addColorStop(0.8, '#5c2450');
  g.addColorStop(1, '#c9513f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  for (let i = 0; i < 130; i++) {
    const sx = (i * 137.5) % W;
    const sy = (i * 71.3) % 900;
    const tw = 0.35 + Math.abs(Math.sin(t * 1.4 + i)) * 0.55;
    ctx.globalAlpha = tw * 0.6;
    ctx.fillStyle = i % 7 === 0 ? '#ffd166' : '#ffffff';
    ctx.fillRect(sx, sy, i % 9 === 0 ? 2.5 : 1.6, i % 9 === 0 ? 2.5 : 1.6);
  }
  ctx.restore();

  const moonX = 790;
  const moonY = 470;
  const glow = ctx.createRadialGradient(moonX, moonY, 40, moonX, moonY, 320);
  glow.addColorStop(0, 'rgba(255, 214, 170, 0.42)');
  glow.addColorStop(1, 'rgba(255, 214, 170, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(moonX - 320, moonY - 320, 640, 640);
  ctx.beginPath();
  ctx.arc(moonX, moonY, 108, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe9c9';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(moonX - 30, moonY - 22, 21, 0, Math.PI * 2);
  ctx.arc(moonX + 36, moonY + 30, 14, 0, Math.PI * 2);
  ctx.arc(moonX + 10, moonY - 52, 9, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(214, 174, 130, 0.35)';
  ctx.fill();

  // 远山
  drawHills(0.08, GROUND - 170, 130, '#231436', t);
  drawHills(0.16, GROUND - 90, 90, '#2c1a44', t);

  // 城市
  const cityOffset = (state.camera * 0.3) % 220;
  ctx.fillStyle = 'rgba(16, 10, 30, 0.92)';
  for (let i = -1; i < 12; i++) {
    const bx = i * 190 - cityOffset;
    const bh = 60 + ((i * 53) % 130);
    ctx.fillRect(bx, GROUND - bh, 150, bh);
    ctx.fillStyle = 'rgba(255, 209, 102, 0.5)';
    for (let wy = GROUND - bh + 14; wy < GROUND - 16; wy += 22) {
      for (let wx = bx + 14; wx < bx + 130; wx += 26) {
        if ((wx + wy + i) % 7 === 0) ctx.fillRect(wx, wy, 7, 9);
      }
    }
    ctx.fillStyle = 'rgba(16, 10, 30, 0.92)';
  }

  // 云
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#ffb08a';
  for (let i = 0; i < 5; i++) {
    const cx = ((i * 460 - state.camera * 0.12) % (W + 400)) - 200;
    const cy = 250 + (i % 3) * 150;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 120, 26, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 60, cy - 14, 80, 22, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHills(parallax, baseY, amp, color, t) {
  const offset = (state.camera * parallax) % 600;
  ctx.beginPath();
  ctx.moveTo(-100, GROUND);
  for (let x = -100; x <= W + 100; x += 20) {
    const y = baseY + Math.sin((x + offset) / 220) * amp * 0.35 + Math.sin((x + offset) / 90) * amp * 0.12;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W + 100, GROUND);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawGround() {
  ctx.fillStyle = '#0c0818';
  ctx.fillRect(0, GROUND, W, H - GROUND);

  const grad = ctx.createLinearGradient(0, GROUND, 0, GROUND + 70);
  grad.addColorStop(0, 'rgba(255, 140, 90, 0.28)');
  grad.addColorStop(1, 'rgba(255, 140, 90, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, GROUND, W, 70);

  ctx.fillStyle = '#ff9f68';
  ctx.fillRect(0, GROUND, W, 3);

  const offset = state.camera % 120;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  for (let x = -offset; x < W; x += 120) {
    ctx.fillRect(x, GROUND + 26, 56, 5);
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  for (let x = -offset + 30; x < W; x += 120) {
    ctx.fillRect(x, GROUND + 58, 30, 4);
  }
}

function drawObstacles() {
  for (const o of state.obstacles) {
    if (o.type === 'gap') {
      // 坑洞只挖到面板上沿，底部与地面条对齐，避免在暗背景上读成黑方块
      const depth = PANEL_TOP - GROUND;
      const pit = ctx.createLinearGradient(0, GROUND, 0, PANEL_TOP);
      pit.addColorStop(0, '#000000');
      pit.addColorStop(0.7, '#030109');
      pit.addColorStop(1, '#0a0616');
      ctx.fillStyle = pit;
      ctx.fillRect(o.x, GROUND, o.w, depth);

      ctx.fillStyle = '#ff6b6b';
      ctx.fillRect(o.x, GROUND, 5, 34);
      ctx.fillRect(o.x + o.w - 5, GROUND, 5, 34);

      ctx.fillStyle = '#ff9f68';
      ctx.fillRect(o.x - 12, GROUND, 12, 3);
      ctx.fillRect(o.x + o.w, GROUND, 12, 3);
      continue;
    }
    if (o.type === 'crate') {
      ctx.fillStyle = '#7a4a2a';
      rr(o.x, GROUND - o.h, o.w, o.h, 8);
      ctx.fill();
      ctx.strokeStyle = '#b07a44';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(o.x + 8, GROUND - o.h + 10);
      ctx.lineTo(o.x + o.w - 8, GROUND - 10);
      ctx.moveTo(o.x + o.w - 8, GROUND - o.h + 10);
      ctx.lineTo(o.x + 8, GROUND - 10);
      ctx.strokeStyle = 'rgba(255, 220, 160, 0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = '#ff6b6b';
      for (let i = 0; i < 3; i++) {
        const sx = o.x + i * (o.w / 3);
        ctx.beginPath();
        ctx.moveTo(sx, GROUND);
        ctx.lineTo(sx + o.w / 6, GROUND - o.h);
        ctx.lineTo(sx + o.w / 3, GROUND);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(255, 107, 107, 0.25)';
      ctx.fillRect(o.x, GROUND - 6, o.w, 6);
    }
  }
}

function drawCoins(t) {
  for (const coin of state.coins) {
    const wobble = Math.abs(Math.cos(t * 4 + coin.spin));
    ctx.save();
    ctx.translate(coin.x, coin.y);
    ctx.scale(0.35 + wobble * 0.65, 1);
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd166';
    ctx.fill();
    ctx.strokeStyle = '#b8860b';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function drawChars(t) {
  const list = [...state.chars.values()].sort((a, b) => a.scale - b.scale);
  for (const c of list) drawChar(c, t);
}

function drawChar(c, t) {
  const s = c.scale;
  const airborne = Math.max(0, GROUND - c.y);
  const bodyH = 62 * s;
  const bodyW = 46 * s;
  const centerY = c.y - bodyH / 2;
  let scale = s;
  const joinAge = t - c.joinedAt;
  if (joinAge < 0.4) scale *= 0.5 + 0.5 * easeOutBack(joinAge / 0.4);

  // 影子
  const shadowAlpha = 0.28 * (1 - Math.min(1, airborne / 420));
  ctx.globalAlpha = shadowAlpha;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(c.x, GROUND + 6, 26 * scale, 8 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // 加速尾迹
  if (t < c.boostUntil) {
    for (let i = 0; i < 4; i++) {
      ctx.globalAlpha = 0.22 - i * 0.04;
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(c.x - 60 - i * 34, c.y - bodyH * 0.7 + i * 10, 44, 6);
    }
    ctx.globalAlpha = 1;
  }

  ctx.save();
  ctx.translate(c.x, centerY);
  const tumbling = t < c.tumbleUntil;
  if (tumbling) {
    const k = (c.tumbleUntil - t) / 1.05;
    ctx.rotate(Math.sin(t * 26 + c.tumbleSeed) * 0.22 * k);
  }

  // 礼物光环
  if (t < c.giftUntil) {
    ctx.beginPath();
    ctx.arc(0, 0, 44 * scale, 0, Math.PI * 2);
    ctx.strokeStyle = `hsl(${(t * 240) % 360} 90% 65%)`;
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 身体
  const bw = bodyW * (scale / s);
  const bh = bodyH * (scale / s);
  const grad = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  grad.addColorStop(0, c.color);
  grad.addColorStop(1, darken(c.color, 16));
  rr(-bw / 2, -bh / 2, bw, bh, Math.min(bw, bh) * 0.4);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 脚
  const swing = c.onGround && !tumbling ? Math.sin(t * 12 + c.phase) : 0;
  ctx.fillStyle = '#2a1c3d';
  rr(-bw * 0.34 + swing * 5, bh / 2 - 4, bw * 0.3, 12, 6);
  ctx.fill();
  rr(bw * 0.04 - swing * 5, bh / 2 - 4, bw * 0.3, 12, 6);
  ctx.fill();

  // 眼睛
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(-8 * s, -7 * s, 7 * s, 0, Math.PI * 2);
  ctx.arc(9 * s, -7 * s, 7 * s, 0, Math.PI * 2);
  ctx.fill();
  const look = tumbling ? 0 : Math.sin(t * 2 + c.phase) * 1.6;
  ctx.fillStyle = '#22162f';
  ctx.beginPath();
  ctx.arc(-8 * s + look, -6 * s, 3.2 * s, 0, Math.PI * 2);
  ctx.arc(9 * s + look, -6 * s, 3.2 * s, 0, Math.PI * 2);
  ctx.fill();

  if (tumbling) {
    ctx.strokeStyle = '#22162f';
    ctx.lineWidth = 2.2 * s;
    ctx.beginPath();
    ctx.moveTo(-15 * s, 10 * s);
    ctx.lineTo(-7 * s, 16 * s);
    ctx.moveTo(-7 * s, 10 * s);
    ctx.lineTo(-15 * s, 16 * s);
    ctx.stroke();
  } else {
    ctx.strokeStyle = '#22162f';
    ctx.lineWidth = 2.2 * s;
    ctx.beginPath();
    ctx.arc(1 * s, 4 * s, 8 * s, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }

  // 护盾
  if (t < c.shieldUntil) {
    ctx.beginPath();
    ctx.arc(0, 0, 42 * scale, t * 2.4, t * 2.4 + Math.PI * 1.5);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.9)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 被撞星星
  if (tumbling) {
    for (let i = 0; i < 3; i++) {
      const a = t * 6 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 34 * scale, -30 * scale + Math.sin(a) * 10, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // 昵称标签
  if (t < c.labelUntil) {
    const fontSize = Math.round(16 * Math.max(0.85, s));
    const font = `700 ${fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    const label = truncate(c.isAI ? `${c.nick} · AI` : c.nick, 170, font);
    ctx.font = font;
    const tw = Math.min(170, ctx.measureText(label).width);
    const lx = c.x - tw / 2 - 10;
    const ly = c.y - bodyH - 34;
    ctx.globalAlpha = Math.min(1, (c.labelUntil - t) / 0.4);
    pill(lx, ly, tw + 20, 30, 'rgba(10, 6, 20, 0.78)', `${c.color}`);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 10, ly + 16, tw);
    ctx.globalAlpha = 1;
  }

  // 跳跃蓄力显示 / 没蓄力且障碍临近时提示发弹幕
  if (!c.isAI && state.phase === 'running' && c.onGround) {
    const up = t < c.labelUntil ? 34 : 0;
    const by = c.y - bodyH - 34 - up;
    if (c.jumpTickets > 0) {
      const text = `跳×${c.jumpTickets}`;
      ctx.font = '800 18px "Microsoft YaHei", "PingFang SC", sans-serif';
      const tw = ctx.measureText(text).width + 22;
      pill(c.x - tw / 2, by, tw, 32, 'rgba(16, 44, 64, 0.9)', 'rgba(155, 231, 255, 0.85)');
      ctx.fillStyle = '#9be7ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, c.x, by + 17);
    } else if (t >= c.tumbleUntil && t >= c.shieldUntil && t >= c.boostUntil) {
      const next = state.obstacles.find((o) => o.x > c.x + 30);
      if (next && next.x - c.x < 460) {
        const pulse = 0.7 + Math.abs(Math.sin(t * 4)) * 0.3;
        const text = '发「跳」';
        ctx.font = '800 18px "Microsoft YaHei", "PingFang SC", sans-serif';
        const tw = ctx.measureText(text).width + 26;
        ctx.globalAlpha = pulse;
        pill(c.x - tw / 2, by, tw, 32, 'rgba(12, 32, 52, 0.88)', 'rgba(155, 231, 255, 0.65)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#9be7ff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, c.x, by + 17);
      }
    }
  }
}

function drawParticles() {
  for (const p of state.particles) {
    const k = 1 - p.life / p.ttl;
    ctx.globalAlpha = Math.max(0, k);
    ctx.fillStyle = p.color;
    if (p.shape === 'rect') {
      ctx.fillRect(p.x, p.y, p.size, p.size);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  for (const f of state.floats) {
    const k = 1 - f.life / f.ttl;
    ctx.globalAlpha = Math.max(0, k);
    ctx.font = '800 26px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = f.color;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 4;
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
}

function drawHUD(t) {
  // 顶部：标题与连接状态
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '900 44px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText('弹幕闯关大乱斗', 40, 74);

  ctx.font = '600 19px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#cbbfe5';
  const sub = `${state.roomTitle || '等待直播间'} · 在线 ${formatCount(state.online)} · 点赞 ${formatCount(state.likes)}`;
  ctx.fillText(truncate(sub, 620, '600 19px "Microsoft YaHei", sans-serif'), 42, 118);

  const connected = state.connected;
  const statusText = connected ? '弹幕已连接' : '未连接弹幕';
  ctx.font = '700 17px "Microsoft YaHei", sans-serif';
  const statusW = ctx.measureText(statusText).width + 44;
  pill(W - 40 - statusW, 52, statusW, 38, connected ? 'rgba(30, 92, 62, 0.75)' : 'rgba(70, 60, 90, 0.75)');
  ctx.beginPath();
  ctx.arc(W - 40 - statusW + 21, 71, 7, 0, Math.PI * 2);
  ctx.fillStyle = connected ? '#57f287' : '#8d84a3';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.fillText(statusText, W - 40 - statusW + 35, 72);

  // 计时
  const cx = W / 2;
  ctx.textAlign = 'center';
  ctx.font = '800 24px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.fillText(`第 ${state.round} 轮`, cx, 182);

  const remain = state.phase === 'running' ? state.roundSeconds - state.elapsed : 0;
  ctx.font = '900 66px "Roboto Mono", "Microsoft YaHei", monospace';
  ctx.fillStyle = '#fff';
  ctx.fillText(fmtTime(remain), cx, 242);

  const barW = 640;
  const barX = cx - barW / 2;
  pill(barX, 278, barW, 12, 'rgba(255, 255, 255, 0.16)');
  const progress = state.phase === 'running' ? Math.min(1, state.elapsed / state.roundSeconds) : 1;
  pill(barX, 278, Math.max(12, barW * progress), 12, '#ffd166');

  ctx.font = '600 17px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#cbbfe5';
  ctx.fillText(`点赞加速 ${Math.floor(state.likeEnergy)}/130`, cx, 312);
  if (t < state.surgeUntil) {
    ctx.fillStyle = '#ffd166';
    ctx.font = '900 26px "Microsoft YaHei", sans-serif';
    ctx.fillText('全场加速中！', cx, 350);
  }

  // 底部信息区
  ctx.fillStyle = 'rgba(9, 6, 20, 0.94)';
  ctx.fillRect(0, PANEL_TOP, W, H - PANEL_TOP);
  ctx.fillStyle = 'rgba(255, 159, 104, 0.4)';
  ctx.fillRect(0, PANEL_TOP, W, 2);

  drawLeaderboard();
  drawTotals();
  drawCTA(t);
  drawFeed(t);
  drawGiftBanner(t);
  drawToasts(t);
  drawResult(t);
}

function drawLeaderboard() {
  const x = 24;
  const y = 1608;
  const w = 524;
  const h = 292;
  pill(x, y, w, h, 'rgba(12, 8, 22, 0.88)', 'rgba(255, 255, 255, 0.1)');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '800 24px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.fillText('本局排行', x + 24, y + 36);

  const list = [...state.chars.values()]
    .filter((c) => !c.isAI)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const rowH = 44;
  const startY = y + 86;
  const medal = ['#ffd166', '#d9d9e8', '#e29b6b'];
  list.forEach((c, i) => {
    const ry = startY + i * rowH;
    if (i < 3) {
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = medal[i];
      rr(x + 14, ry - 19, w - 28, 40, 12);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
    ctx.font = '900 20px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = i < 3 ? medal[i] : '#9b90b8';
    ctx.fillText(String(i + 1), x + 24, ry + 2);

    ctx.beginPath();
    ctx.arc(x + 66, ry + 2, 10, 0, Math.PI * 2);
    ctx.fillStyle = c.color;
    ctx.fill();

    ctx.font = '700 20px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#fff';
    const name = truncate(c.isAI ? `${c.nick} · AI` : c.nick, 260, '700 20px "Microsoft YaHei", sans-serif');
    ctx.fillText(name, x + 86, ry + 2);

    ctx.textAlign = 'right';
    ctx.font = '800 21px "Roboto Mono", "Microsoft YaHei", monospace';
    ctx.fillStyle = '#cbbfe5';
    ctx.fillText(String(Math.floor(c.score)), x + w - 24, ry + 2);
  });

  if (list.length < 3) {
    ctx.textAlign = 'left';
    ctx.font = '600 18px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#7d7398';
    ctx.fillText(
      list.length ? '还有空位，发弹幕就能上车' : '发任意弹幕就能上车',
      x + 26,
      startY + list.length * rowH + 12,
    );
  }
}

function drawTotals() {
  const x = 560;
  const y = 1608;
  const w = 496;
  const h = 292;
  pill(x, y, w, h, 'rgba(12, 8, 22, 0.88)', 'rgba(255, 255, 255, 0.1)');
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'left';
  ctx.font = '800 24px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#8ef0c0';
  ctx.fillText('今日总榜', x + 24, y + 36);

  ctx.textAlign = 'right';
  ctx.font = '600 16px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#9b90b8';
  const date = state.totals?.date ? String(state.totals.date).slice(5) : '';
  ctx.fillText(date ? `累计 ${date}` : '累计', x + w - 24, y + 37);

  const top = (state.totals?.top || []).slice(0, 3);
  if (!top.length) {
    ctx.textAlign = 'center';
    ctx.font = '600 18px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#9b90b8';
    ctx.fillText('本轮结算后更新', x + w / 2, y + 170);
    return;
  }

  const medal = ['#ffd166', '#d9d9e8', '#e29b6b'];
  top.forEach((p, i) => {
    const ry = y + 90 + i * 58;
    if (i === 0) {
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = medal[0];
      rr(x + 14, ry - 22, w - 28, 48, 10);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
    ctx.font = '900 21px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = medal[i];
    ctx.fillText(String(i + 1), x + 24, ry + 2);

    ctx.font = '700 20px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#fff';
    const name = truncate(p.nick, 280, '700 20px "Microsoft YaHei", sans-serif');
    ctx.fillText(name, x + 58, ry + 2);

    ctx.textAlign = 'right';
    ctx.font = '800 21px "Roboto Mono", "Microsoft YaHei", monospace';
    ctx.fillStyle = '#8ef0c0';
    ctx.fillText(String(p.score), x + w - 24, ry + 2);
  });
}

function drawFeed(t) {
  const x = 40;
  const bottom = 1332;
  const lineH = 36;
  const lines = state.feed.slice(-6);
  ctx.textBaseline = 'middle';
  lines.forEach((f, i) => {
    const idx = lines.length - 1 - i;
    const y = bottom - idx * lineH;
    const age = t - f.t;
    const alpha = Math.min(1, Math.max(0, (30 - age) / 2)) * (age < 0.3 ? age / 0.3 : 1);
    if (alpha <= 0) return;
    const slide = age < 0.35 ? (1 - age / 0.35) * 30 : 0;
    ctx.globalAlpha = alpha;
    const nick = truncate(f.nick, 160, '700 19px "Microsoft YaHei", sans-serif');
    const text = truncate(f.content, 520, '500 19px "Microsoft YaHei", sans-serif');
    ctx.font = '700 19px "Microsoft YaHei", sans-serif';
    const nw = ctx.measureText(nick).width;
    ctx.font = '500 19px "Microsoft YaHei", sans-serif';
    const cw = ctx.measureText(text).width;
    const total = nw + cw + 34;
    pill(x - 6 - slide, y - 16, total, 32, 'rgba(10, 6, 20, 0.62)');
    ctx.textAlign = 'left';
    ctx.font = '700 19px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = f.color;
    ctx.fillText(nick, x + 8 - slide, y + 1);
    ctx.font = '500 19px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#efe9ff';
    ctx.fillText(text, x + 16 + nw - slide, y + 1);
    ctx.globalAlpha = 1;
  });

}

function drawGiftBanner(t) {
  if (!state.giftBanner) return;
  const b = state.giftBanner;
  const k = Math.min(1, (b.until - t) / 0.4);
  const y = 560;
  ctx.globalAlpha = k;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = `感谢「${truncate(b.nick, 260, '700 24px "Microsoft YaHei", sans-serif')}」送出 ${b.gift} ×${b.count}`;
  ctx.font = '700 24px "Microsoft YaHei", sans-serif';
  const w = Math.min(960, ctx.measureText(text).width + 70);
  pill(W / 2 - w / 2, y - 28, w, 56, 'rgba(60, 32, 8, 0.8)', 'rgba(255, 209, 102, 0.6)');
  ctx.fillStyle = '#ffd166';
  ctx.fillText(text, W / 2, y);
  ctx.globalAlpha = 1;
}

function drawToasts(t) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  state.toasts.forEach((toast, i) => {
    const y = 1196 - i * 46;
    const alpha = Math.min(1, (toast.until - t) / 0.4);
    ctx.globalAlpha = alpha;
    ctx.font = '700 22px "Microsoft YaHei", sans-serif';
    const w = ctx.measureText(toast.text).width + 50;
    pill(W / 2 - w / 2, y - 20, w, 40, 'rgba(10, 6, 20, 0.7)', 'rgba(255, 209, 102, 0.35)');
    ctx.fillStyle = '#fff';
    ctx.fillText(toast.text, W / 2, y + 1);
    ctx.globalAlpha = 1;
  });
}

function drawCTA(t) {
  const cx = W / 2;
  const main = '发任意弹幕就能上车';
  const pulse = 0.74 + Math.abs(Math.sin(t * 1.6)) * 0.26;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 40px "Microsoft YaHei", "PingFang SC", sans-serif';
  const pw = ctx.measureText(main).width + 76;
  ctx.globalAlpha = pulse;
  pill(cx - pw / 2, 374, pw, 62, '#ffd166');
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#1c1206';
  ctx.fillText(main, cx, 406);

  const sub = '「跳」才能过障碍 · 「冲」加速 · 「护」护盾 · 其他弹幕也加分';
  ctx.font = '600 22px "Microsoft YaHei", sans-serif';
  const sw = ctx.measureText(sub).width + 44;
  pill(cx - sw / 2, 448, sw, 38, 'rgba(12, 8, 22, 0.72)', 'rgba(255, 255, 255, 0.12)');
  ctx.fillStyle = 'rgba(239, 233, 255, 0.94)';
  ctx.fillText(sub, cx, 468);
}

function drawResult(t) {
  if (state.phase !== 'result' || !state.result) return;
  const r = state.result;
  ctx.fillStyle = 'rgba(5, 3, 12, 0.62)';
  ctx.fillRect(0, 0, W, H);

  const x = 90;
  const y = 600;
  const w = 900;
  const h = 660;
  rr(x, y, w, h, 36);
  ctx.fillStyle = 'rgba(18, 12, 32, 0.94)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 52px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.fillText(`第 ${r.round} 轮结束`, x + w / 2, y + 96);

  const medals = ['🥇', '🥈', '🥉'];
  const medalColors = ['#ffd166', '#d9d9e8', '#e29b6b'];
  if (!r.ranked.length) {
    ctx.font = '700 28px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#cbbfe5';
    ctx.fillText('这一轮没有观众上场，下一轮一起来！', x + w / 2, y + 320);
  }
  r.ranked.forEach((c, i) => {
    const ry = y + 220 + i * 108;
    pill(x + 60, ry - 40, w - 120, 82, 'rgba(255, 255, 255, 0.06)');
    ctx.textAlign = 'left';
    ctx.font = '900 36px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = medalColors[i];
    ctx.fillText(medals[i], x + 92, ry + 2);
    ctx.font = '800 32px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(truncate(c.nick, 400, '800 32px "Microsoft YaHei", sans-serif'), x + 160, ry + 2);
    ctx.textAlign = 'right';
    ctx.font = '900 34px "Roboto Mono", "Microsoft YaHei", monospace';
    ctx.fillStyle = '#ffd166';
    ctx.fillText(`${Math.floor(c.score)} 分`, x + w - 92, ry + 2);
  });

  const top1 = state.totals?.top?.[0];
  if (top1) {
    ctx.textAlign = 'center';
    ctx.font = '700 23px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#8ef0c0';
    ctx.fillText(
      `今日总榜第 1：${truncate(top1.nick, 420, '700 23px "Microsoft YaHei", sans-serif')} ${top1.score} 分`,
      x + w / 2,
      y + h - 122,
    );
  }

  const left = Math.max(0, Math.ceil(r.until - t));
  ctx.textAlign = 'center';
  ctx.font = '700 24px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#cbbfe5';
  ctx.fillText(`${left} 秒后开始下一轮`, x + w / 2, y + h - 62);
}

function render(t) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05030c';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.save();
  ctx.translate(viewX, viewY);
  ctx.scale(viewScale, viewScale);
  ctx.fillStyle = '#05030c';
  ctx.fillRect(0, 0, W, H);

  drawBackground(t);
  drawGround();
  drawObstacles();
  drawCoins(t);
  drawChars(t);
  drawParticles();
  drawHUD(t);

  ctx.restore();
}

// ---------- loop ----------
let last = now();
function frame() {
  const t = now();
  const dt = Math.min(0.05, Math.max(0, t - last));
  last = t;
  update(dt, t);
  render(t);
  requestAnimationFrame(frame);
}

// ---------- 语音播报 ----------
const voiceQueue = {
  list: [],
  audio: null,
  blocked: false,
};

function enqueueVoice(url) {
  if (!url) return;
  if (voiceQueue.list.length >= 4) voiceQueue.list.shift();
  voiceQueue.list.push(url);
  pumpVoice();
}

function pumpVoice() {
  if (voiceQueue.audio || voiceQueue.blocked || !voiceQueue.list.length) return;
  const url = voiceQueue.list.shift();
  const audio = new Audio(url);
  voiceQueue.audio = audio;
  audio.volume = 0.9;
  audio.addEventListener(
    'loadedmetadata',
    () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        state.voiceUntil = Math.max(state.voiceUntil, now() + audio.duration);
      }
    },
    { once: true },
  );
  const finish = () => {
    if (voiceQueue.audio === audio) voiceQueue.audio = null;
    pumpVoice();
  };
  audio.addEventListener('ended', finish, { once: true });
  audio.addEventListener('error', finish, { once: true });
  audio.play().catch(() => {
    if (voiceQueue.audio === audio) voiceQueue.audio = null;
    voiceQueue.blocked = true;
    voiceQueue.list.unshift(url);
    addToast('点一下直播画面，开启语音播报');
  });
}

function unlockVoice() {
  if (!voiceQueue.blocked) return;
  voiceQueue.blocked = false;
  window.removeEventListener('pointerdown', unlockVoice);
  window.removeEventListener('keydown', unlockVoice);
  pumpVoice();
}
window.addEventListener('pointerdown', unlockVoice);
window.addEventListener('keydown', unlockVoice);

// 没人发弹幕时，隔一会儿解说一句，直播不冷场
const HOST_LINES = [
  '发任意弹幕就能上车，角色会自动闯关',
  '发「跳」帮角色跳过障碍，发「冲」可以加速',
  '发「护」能开六秒护盾，送礼物还能直接加分',
  '点赞攒满一百三十，触发全场加速',
  '每轮七十五秒，前三名会上榜',
];
let nextHostAt = 0;
let hostLineIdx = 0;

function maybeHostTalk(t) {
  if (!state.voiceOn || state.phase !== 'running' || voiceQueue.blocked) return;
  if (!nextHostAt) nextHostAt = t + 12;
  if (t < nextHostAt) return;
  nextHostAt = t + 26 + Math.random() * 8;
  if (t < state.voiceUntil + 1) return;
  if (t - state.lastChatAt < 7) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const real = [...state.chars.values()]
    .filter((c) => !c.isAI && !c.sim)
    .sort((a, b) => b.score - a.score);
  let text;
  if (!real.length) {
    text = hostLineIdx % 2 === 0 ? '评论区发任意弹幕，马上就能加入闯关' : HOST_LINES[hostLineIdx % HOST_LINES.length];
  } else if (hostLineIdx % 3 === 2) {
    text = `${String(real[0].nick).replace(/\s+/g, ' ').trim().slice(0, 12)} 目前领先，发弹幕就能反超`;
  } else {
    text = HOST_LINES[hostLineIdx % HOST_LINES.length];
  }
  hostLineIdx += 1;
  ws.send(JSON.stringify({ type: 'speak', text }));
  state.voiceUntil = t + 5;
}

function sendRoundResult() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const players = [...state.chars.values()]
    .filter((c) => !c.isAI && !c.sim)
    .map((c) => ({ uid: c.uid, nick: c.nick, score: Math.floor(c.score) }));
  if (!players.length) return;
  ws.send(JSON.stringify({ type: 'round-result', round: state.round, players }));
}

function announceWinners(ranked, round) {
  if (!ranked.length) return;
  const names = ranked
    .map((c) => String(c.nick).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12))
    .filter(Boolean)
    .join('、');
  if (!names) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'speak', text: `第 ${round} 轮结束，恭喜 ${names} 中榜！` }));
}

// ---------- websocket ----------
let ws = null;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello':
        applyState(msg.state);
        if (msg.totals) state.totals = msg.totals;
        for (const item of msg.history || []) {
          if (item.type === 'chat') onChat(item, true);
        }
        break;
      case 'chat':
        onChat(msg);
        break;
      case 'like':
        onLike(msg);
        break;
      case 'gift':
        onGift(msg);
        break;
      case 'member':
        onMember(msg);
        break;
      case 'voice':
        enqueueVoice(msg.url);
        break;
      case 'totals':
        state.totals = msg;
        break;
      case 'status':
        applyState(msg.state);
        break;
      case 'log':
        break;
      default:
        break;
    }
  });
  ws.addEventListener('close', () => {
    state.connected = false;
    setTimeout(connectWS, 2000);
  });
  ws.addEventListener('error', () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  });
}

function applyState(payload) {
  if (!payload) return;
  const live = payload.live || {};
  state.connected = live.phase === 'connected';
  state.voiceOn = payload.voice !== false;
  state.roomTitle = live.title || '';
  if (Number(payload.roundSeconds) >= 5 && !roundOverride) {
    state.roundSeconds = Number(payload.roundSeconds);
  }
}

if (new URLSearchParams(location.search).has('debug')) {
  window.__game = { state, onChat };
}

addAICompanions();
state.connected = false;
connectWS();
requestAnimationFrame(frame);

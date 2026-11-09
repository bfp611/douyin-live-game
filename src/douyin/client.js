import { EventEmitter } from 'node:events';
import DanmaClient from './vendor/index.js';
import { resolveDouyinRoom } from './room-resolve.js';

const STATUS_LIVE = 2;
const RESOLVE_RETRY_MS = 15_000;
const CONNECT_RETRY_MS = 5_000;

function now() {
  return Date.now();
}

function userOf(msg) {
  const u = msg?.user ?? {};
  return {
    uid: u.id != null ? String(u.id) : u.idStr != null ? String(u.idStr) : undefined,
    nickname: u.nickName ?? u.nickname ?? '观众',
  };
}

export class DouyinLive extends EventEmitter {
  #input;
  #client = null;
  #stopped = true;
  #timer = null;
  #watchTimer = null;
  #roomId = null;
  #state = {
    phase: 'idle',
    webRoomId: null,
    roomId: null,
    title: null,
    status: null,
    lastError: null,
    messages: 0,
    chats: 0,
    lastMessageAt: null,
    connectedAt: null,
  };

  constructor(input) {
    super();
    this.#input = input;
  }

  get state() {
    return { ...this.#state };
  }

  async start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    await this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#watchTimer);
    this.#timer = null;
    this.#watchTimer = null;
    this.#teardown();
    this.#patch({ phase: 'stopped' });
  }

  #patch(patch) {
    this.#state = { ...this.#state, ...patch };
    this.emit('status', this.state);
  }

  #teardown() {
    if (!this.#client) return;
    try {
      this.#client.close();
    } catch {
      // socket may already be closed
    }
    this.#client = null;
  }

  #retry(ms) {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), ms);
  }

  async #connect() {
    if (this.#stopped) return;
    this.#teardown();
    clearInterval(this.#watchTimer);
    this.#patch({ phase: 'connecting' });

    let room;
    try {
      room = await resolveDouyinRoom(this.#input);
    } catch (err) {
      this.#patch({ phase: 'retrying', lastError: err.message });
      this.emit('log', 'error', `解析直播间失败：${err.message}`);
      this.#retry(RESOLVE_RETRY_MS);
      return;
    }
    if (this.#stopped) return;

    this.#roomId = room.roomId;
    this.#patch({
      webRoomId: room.webRoomId,
      roomId: room.roomId,
      title: room.title,
      status: room.status,
      lastError: null,
    });
    this.emit('room', room);

    if (room.status != null && room.status !== STATUS_LIVE) {
      this.#patch({ phase: 'retrying', lastError: `房间未开播（status=${room.status}），等待开播` });
      this.emit('log', 'warn', '房间当前未开播，15 秒后重新解析（开播后内部房间号会变）');
      this.#retry(RESOLVE_RETRY_MS);
      return;
    }

    const client = new DanmaClient(room.roomId, {
      autoReconnect: 50,
      heartbeatInterval: 8_000,
      timeoutInterval: 300_000,
      reconnectInterval: 3_000,
      cookie: room.cookie || undefined,
    });
    this.#client = client;

    client.on('open', () => {
      this.#patch({ phase: 'connected', connectedAt: now(), lastError: null });
      this.emit('log', 'info', '已连接抖音直播弹幕');
      this.#watchRoom();
    });
    client.on('close', () => {
      this.#patch({ phase: 'retrying' });
      this.emit('log', 'warn', '弹幕连接断开，正在重连');
    });
    client.on('error', (err) => {
      const message = err?.message ?? String(err);
      this.#patch({ lastError: message });
      this.emit('log', 'error', `弹幕连接错误：${message}`);
    });

    client.on('chat', (msg) => {
      const { uid, nickname } = userOf(msg);
      this.#state.messages += 1;
      this.#state.chats += 1;
      this.#state.lastMessageAt = now();
      this.emit('chat', {
        uid,
        nickname,
        content: String(msg?.content ?? ''),
        ts: now(),
      });
    });
    client.on('like', (msg) => {
      const { uid, nickname } = userOf(msg);
      this.#state.messages += 1;
      this.#state.lastMessageAt = now();
      this.emit('like', {
        uid,
        nickname,
        count: Number(msg?.count ?? 1) || 1,
        total: Number(msg?.total ?? 0) || 0,
        ts: now(),
      });
    });
    client.on('gift', (msg) => {
      const { uid, nickname } = userOf(msg);
      this.#state.messages += 1;
      this.#state.lastMessageAt = now();
      this.emit('gift', {
        uid,
        nickname,
        giftName: msg?.gift?.name ?? '礼物',
        count: Number(msg?.repeatCount ?? msg?.comboCount ?? 1) || 1,
        diamond: Number(msg?.gift?.diamondCount ?? 0) || 0,
        ts: now(),
      });
    });
    client.on('member', (msg) => {
      const { uid, nickname } = userOf(msg);
      this.#state.messages += 1;
      this.#state.lastMessageAt = now();
      this.emit('member', {
        uid,
        nickname,
        audience: Number(msg?.memberCount ?? 0) || 0,
        ts: now(),
      });
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('连接超时')), 20_000);
        client.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        client.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        client.connect();
      });
    } catch (err) {
      if (this.#stopped) return;
      this.#teardown();
      this.#patch({ phase: 'retrying', lastError: err.message });
      this.emit('log', 'error', `连接弹幕失败：${err.message}`);
      this.#retry(CONNECT_RETRY_MS);
    }
  }

  #watchRoom() {
    clearInterval(this.#watchTimer);
    this.#watchTimer = setInterval(async () => {
      if (this.#stopped) return;
      try {
        const room = await resolveDouyinRoom(this.#input);
        if (this.#stopped) return;
        if (room.status != null && room.status !== STATUS_LIVE) {
          this.emit('log', 'warn', '直播已结束，等待下一场');
          this.#teardown();
          this.#patch({ phase: 'retrying', status: room.status });
          this.#retry(RESOLVE_RETRY_MS);
          return;
        }
        if (this.#roomId && room.roomId !== this.#roomId) {
          this.emit('log', 'info', '检测到新开播场次，切换房间重连');
          this.#teardown();
          this.#roomId = room.roomId;
          this.#patch({ roomId: room.roomId, status: room.status });
          this.#retry(1_000);
        }
      } catch {
        // 直播间信息偶发失败不影响已建立的弹幕连接
      }
    }, 45_000);
  }
}

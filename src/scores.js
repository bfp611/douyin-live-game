import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const file = path.join(dataDir, 'scores.json');
const MAX_PLAYERS = 500;

function today() {
  return new Date().toLocaleDateString('sv-SE');
}

function cleanText(value, limit) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export class ScoreBoard {
  #date = today();
  #roomId = '';
  #updatedAt = 0;
  #players = new Map();

  constructor() {
    this.#load();
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.#roomId = cleanText(data.roomId, 64);
      this.#date = typeof data.date === 'string' ? data.date : this.#date;
      this.#updatedAt = Number(data.updatedAt) || 0;
      for (const raw of Array.isArray(data.players) ? data.players : []) {
        const uid = cleanText(raw?.uid, 64);
        if (!uid) continue;
        this.#players.set(uid, {
          uid,
          nick: cleanText(raw?.nick, 24) || '观众',
          score: Math.max(0, Math.floor(Number(raw?.score) || 0)),
          rounds: Math.max(0, Math.floor(Number(raw?.rounds) || 0)),
          lastAt: Number(raw?.lastAt) || 0,
        });
      }
      if (this.#date !== today()) this.#reset(today());
    } catch {
      // 首次运行或文件损坏，从空榜开始
    }
  }

  #reset(date = today()) {
    this.#date = date;
    this.#players.clear();
    this.#updatedAt = 0;
  }

  #save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const body = {
      date: this.#date,
      roomId: this.#roomId,
      updatedAt: this.#updatedAt,
      players: [...this.#players.values()].sort((a, b) => b.score - a.score).slice(0, MAX_PLAYERS),
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  setRoom(roomId) {
    const next = cleanText(roomId, 64);
    if (!next || next === this.#roomId) return false;
    this.#roomId = next;
    this.#reset();
    this.#save();
    return true;
  }

  addRound(players) {
    if (this.#date !== today()) this.#reset(today());
    let changed = false;
    const now = Date.now();
    for (const raw of Array.isArray(players) ? players : []) {
      const uid = cleanText(raw?.uid, 64);
      const score = Math.floor(Number(raw?.score) || 0);
      if (!uid || score <= 0 || score > 1000000) continue;
      const nick = cleanText(raw?.nick, 24) || '观众';
      const prev = this.#players.get(uid);
      if (prev) {
        prev.score += score;
        prev.rounds += 1;
        prev.nick = nick;
        prev.lastAt = now;
      } else {
        this.#players.set(uid, { uid, nick, score, rounds: 1, lastAt: now });
      }
      changed = true;
    }
    if (changed) {
      this.#updatedAt = now;
      this.#trim();
      this.#save();
    }
    return changed;
  }

  #trim() {
    if (this.#players.size <= MAX_PLAYERS) return;
    const kept = [...this.#players.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PLAYERS);
    this.#players = new Map(kept.map((p) => [p.uid, p]));
  }

  snapshot(limit = 10) {
    if (this.#date !== today()) this.#reset(today());
    return {
      date: this.#date,
      roomId: this.#roomId,
      updatedAt: this.#updatedAt,
      top: [...this.#players.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ uid, nick, score, rounds }) => ({ uid, nick, score, rounds })),
    };
  }
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'tts');
const script = path.join(root, 'src', 'tts.ps1');
const MAX_TEXT = 60;
const MAX_FILES = 150;

export class VoiceQueue extends EventEmitter {
  #queue = [];
  #busy = false;
  #recent = new Map();
  #synthCount = 0;
  #enabled = true;

  constructor({ voice = 'Microsoft Huihui Desktop', rate = 0 } = {}) {
    super();
    this.voice = voice;
    this.rate = rate;
  }

  setEnabled(enabled) {
    this.#enabled = Boolean(enabled);
    if (!this.#enabled) this.#queue.length = 0;
  }

  enqueue(text, kind = 'join') {
    if (!this.#enabled) return;
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!clean) return;

    const seenAt = this.#recent.get(clean);
    const now = Date.now();
    if (seenAt && now - seenAt < 8000) return;
    this.#recent.set(clean, now);
    if (this.#recent.size > 300) {
      for (const [key, ts] of this.#recent) {
        if (now - ts > 30_000) this.#recent.delete(key);
      }
    }

    if (kind === 'join' && this.#queue.length >= 3) this.#queue.shift();
    this.#queue.push({ text: clean, kind });
    this.#pump();
  }

  clear() {
    this.#queue.length = 0;
  }

  #pump() {
    if (this.#busy || !this.#queue.length) return;
    this.#busy = true;
    const item = this.#queue.shift();
    this.#run(item)
      .catch((err) => this.emit('error', err))
      .finally(() => {
        this.#busy = false;
        this.#pump();
      });
  }

  async #run(item) {
    fs.mkdirSync(outDir, { recursive: true });
    const key = `${this.voice}|${this.rate}|${item.text}`;
    const hash = createHash('md5').update(key).digest('hex').slice(0, 16);
    const wav = path.join(outDir, `${hash}.wav`);
    if (!fs.existsSync(wav)) {
      const textFile = path.join(os.tmpdir(), `dytts-${hash}-${process.pid}.txt`);
      fs.writeFileSync(textFile, item.text, 'utf8');
      try {
        await this.#synthesize(textFile, wav);
      } finally {
        fs.rmSync(textFile, { force: true });
      }
      this.#synthCount += 1;
      if (this.#synthCount % 20 === 0) this.#prune();
    }
    this.emit('ready', { url: `/tts/${hash}.wav`, text: item.text, kind: item.kind });
  }

  #synthesize(textFile, wav) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-TextFile',
          textFile,
          '-OutFile',
          wav,
          '-Rate',
          String(this.rate),
          '-Voice',
          this.voice,
        ],
        { windowsHide: true },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(wav) && fs.statSync(wav).size > 1000) {
          resolve();
        } else {
          reject(new Error(`语音合成失败 (exit ${code}) ${stderr.trim()}`));
        }
      });
    });
  }

  #prune() {
    try {
      const files = fs
        .readdirSync(outDir)
        .filter((name) => name.endsWith('.wav'))
        .map((name) => ({ name, mtime: fs.statSync(path.join(outDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(MAX_FILES)) {
        fs.rmSync(path.join(outDir, old.name), { force: true });
      }
    } catch {
      // 清理失败不影响播报
    }
  }
}

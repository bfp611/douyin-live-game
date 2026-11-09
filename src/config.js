import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config.json');

const defaults = {
  port: 3000,
  roomId: '',
  roundSeconds: 75,
  voice: true,
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

export const config = load();

export function saveConfig(patch) {
  Object.assign(config, patch);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

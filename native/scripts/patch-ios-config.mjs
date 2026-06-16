// Capacitor 6 on iOS loads plugins listed in `packageClassList` in the native
// capacitor.config.json. That list is auto-generated from npm plugin packages,
// so our app-embedded LooperAudio plugin never lands in it. `cap sync`
// regenerates the file, so we patch it afterward to register the plugin.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(here, '..', 'ios', 'App', 'App', 'capacitor.config.json');
const PLUGIN = 'LooperAudio';

if (!existsSync(cfgPath)) {
  console.log('No native iOS config yet (run `npx cap add ios` first) — skipping plugin patch.');
  process.exit(0);
}

const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
if (!Array.isArray(cfg.packageClassList)) cfg.packageClassList = [];
if (!cfg.packageClassList.includes(PLUGIN)) {
  cfg.packageClassList.push(PLUGIN);
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`Registered ${PLUGIN} in iOS packageClassList`);
} else {
  console.log(`${PLUGIN} already registered in iOS packageClassList`);
}

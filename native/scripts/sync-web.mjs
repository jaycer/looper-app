// Copy the shared web UI (repo root) into native/www, which Capacitor bundles
// into the native app. The service worker is intentionally excluded — it isn't
// needed in a native shell and can serve stale assets across app updates.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const www = join(here, '..', 'www');

const FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'capture-worklet.js',
  'manifest.webmanifest',
];
const DIRS = ['icons'];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

for (const f of FILES) {
  await cp(join(repoRoot, f), join(www, f));
}
for (const d of DIRS) {
  await cp(join(repoRoot, d), join(www, d), { recursive: true });
}

console.log('Synced web UI -> native/www');

// If the iOS project exists and the plugin was added as copied files (Full
// Path under ios/App/App), keep those copies up to date so `git pull` +
// `npm run sync` actually refreshes the compiled Swift.
const iosAppDir = join(here, '..', 'ios', 'App', 'App');
const pluginDir = join(here, '..', 'ios-plugin');
if (existsSync(iosAppDir)) {
  for (const f of ['LooperAudio.swift', 'LooperAudioPlugin.m']) {
    const dest = join(iosAppDir, f);
    if (existsSync(dest)) {
      await cp(join(pluginDir, f), dest);
      console.log(`Refreshed ${f} in ios/App/App`);
    }
  }
}

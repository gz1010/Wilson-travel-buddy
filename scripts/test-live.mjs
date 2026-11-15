#!/usr/bin/env node
// Runs the live model checks (app/src/core/__live__) against a llama-server
// that is already running, on any OS:
//
//   cd app && npm run test:live                       # 127.0.0.1:8080
//   LLM_URL=http://127.0.0.1:8081 npm run test:live   # another server
//
// It prints every answer and timing, and writes them to
// app/src/core/__live__/last-run.json for recording fixtures and benchmarks.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const jest = join(app, 'node_modules', 'jest', 'bin', 'jest.js');
const r = spawnSync(process.execPath, [jest, 'src/core/__live__', '--runInBand', ...process.argv.slice(2)], {
  cwd: app,
  stdio: 'inherit',
  env: { ...process.env, LIVE: '1' },
});
process.exit(r.status ?? 1);

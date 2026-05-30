#!/usr/bin/env node
/**
 * Thin launcher for the `hermes` CLI.
 *
 * The CLI is authored in TypeScript and this monorepo ships packages as raw
 * source (no per-package build step), so we execute it through vite-node —
 * already present via vitest and the same resolver the test suite uses, so it
 * handles the workspace's `.js`-specifier-to-`.ts` imports identically.
 *
 * Everything after the launcher's own args is forwarded to the CLI as argv.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const viteNode = require.resolve('vite-node/vite-node.mjs');
const entry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const child = spawn(process.execPath, [viteNode, entry, '--', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

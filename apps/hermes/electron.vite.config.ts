import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Externalize only the modules that must remain as runtime `require()`s
// (native binaries, the Electron host, Node.js built-ins). Everything else
// gets bundled into out/main/index.js so we can ship the .app without any
// node_modules tree — which keeps pnpm-symlinked workspace deps from
// confusing electron-builder.
const mainExternals = [
  'electron',
  /^node:/,
  // Native modules — bundled as require() so the prebuilt binaries can be
  // resolved at runtime from process.resourcesPath when packaged.
  'better-sqlite3',
  'keytar',
  // Playwright pulls in its own browser binary lookup logic that can't be
  // bundled cleanly with esbuild. Keep it external; the packaged app must
  // ship its node_modules.
  'playwright-core',
];

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'src/main/index.ts'),
      },
      rollupOptions: {
        external: mainExternals,
      },
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
      },
      rollupOptions: {
        external: ['electron', /^node:/],
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react()],
  },
});

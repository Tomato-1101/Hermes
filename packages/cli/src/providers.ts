/**
 * Lazily construct the providers a flow needs and hand back a teardown.
 *
 * Everything heavy (Playwright, the macOS sidecar) is dynamically imported so
 * a provider-less flow never pays for it. Construction order is web → desktop;
 * dispose runs in reverse.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderBag } from '@hermes/engine';
import type { LayerUsage } from './layers.js';

export interface BuildProviderOptions {
  web?: {
    profileDir?: string;
    headless?: boolean;
    channel?: 'chrome' | 'msedge' | 'chromium';
    executablePath?: string;
  };
  desktop?: { sidecarBin?: string };
}

export interface ProviderHandles {
  providers: ProviderBag;
  dispose: () => Promise<void>;
}

export async function buildProviders(
  usage: LayerUsage,
  opts: BuildProviderOptions = {},
): Promise<ProviderHandles> {
  const providers: ProviderBag = {};
  const teardown: Array<() => Promise<void> | void> = [];

  if (usage.web) {
    const { createWebProvider } = await import('@hermes/web-provider');
    const web = createWebProvider({
      profileDir: opts.web?.profileDir ?? join(tmpdir(), `hermes-cli-web-${process.pid}`),
      headless: opts.web?.headless ?? true,
      ...(opts.web?.channel ? { channel: opts.web.channel } : {}),
      ...(opts.web?.executablePath ? { executablePath: opts.web.executablePath } : {}),
    });
    await web.start();
    providers.web = web;
    teardown.push(() => web.close());
  }

  if (usage.desktop) {
    if (process.platform !== 'darwin') {
      throw new Error(
        'This flow uses the desktop layer, which is only supported on macOS in phase 1.',
      );
    }
    const [{ MacosDesktopAdapter }, { DesktopProvider }, { spawnSidecar }] = await Promise.all([
      import('@hermes/desktop-adapter/macos'),
      import('@hermes/desktop-adapter/desktop-provider'),
      import('./sidecar-spawn.js'),
    ]);
    const sidecar = await spawnSidecar(
      opts.desktop?.sidecarBin ? { binaryPath: opts.desktop.sidecarBin } : {},
    );
    const adapter = new MacosDesktopAdapter({ client: sidecar.client });
    providers.desktop = new DesktopProvider(adapter);
    teardown.push(async () => {
      await adapter.dispose();
      sidecar.dispose();
    });
  }

  return {
    providers,
    dispose: async () => {
      for (const t of teardown.reverse()) await t();
    },
  };
}

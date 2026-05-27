import type { HermesApi } from '../preload/index.js';

declare global {
  interface Window {
    hermes: HermesApi;
  }
}

export {};

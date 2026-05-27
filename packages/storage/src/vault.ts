/**
 * Vault: secrets storage backed by the OS keychain via keytar.
 *
 * The "service" string is namespaced so multiple Hermes installs (or test
 * harnesses) don't collide. Account names are flow-scoped:
 *   <service>:<scope>  e.g. "hermes:app" + "openrouter.apiKey"
 *
 * For tests / non-electron contexts where keytar's native binding may not be
 * available, the constructor accepts an injected backend.
 */

export interface VaultBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, value: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

export interface VaultOptions {
  service?: string;
  backend?: VaultBackend;
}

const DEFAULT_SERVICE = 'dev.hermes.app';

export class Vault {
  private readonly service: string;
  private readonly backend: VaultBackend;

  constructor(opts: VaultOptions = {}) {
    this.service = opts.service ?? DEFAULT_SERVICE;
    this.backend = opts.backend ?? lazyKeytarBackend();
  }

  /** Read a secret by account name. Returns null if not set. */
  get(account: string): Promise<string | null> {
    return this.backend.getPassword(this.service, account);
  }

  set(account: string, value: string): Promise<void> {
    return this.backend.setPassword(this.service, account, value);
  }

  delete(account: string): Promise<boolean> {
    return this.backend.deletePassword(this.service, account);
  }

  list(): Promise<Array<{ account: string }>> {
    return this.backend
      .findCredentials(this.service)
      .then((rows) => rows.map((r) => ({ account: r.account })));
  }
}

/** In-memory backend for tests and headless contexts. */
export class InMemoryVaultBackend implements VaultBackend {
  private readonly store = new Map<string, string>();
  async getPassword(service: string, account: string): Promise<string | null> {
    return this.store.get(`${service}:${account}`) ?? null;
  }
  async setPassword(service: string, account: string, value: string): Promise<void> {
    this.store.set(`${service}:${account}`, value);
  }
  async deletePassword(service: string, account: string): Promise<boolean> {
    return this.store.delete(`${service}:${account}`);
  }
  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    const prefix = `${service}:`;
    const out: Array<{ account: string; password: string }> = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) out.push({ account: k.slice(prefix.length), password: v });
    }
    return out;
  }
}

/**
 * Build a VaultBackend that imports keytar lazily so test/headless contexts
 * (where the native binding may not be present) can still construct a Vault
 * with a different backend without paying the import.
 */
function lazyKeytarBackend(): VaultBackend {
  let loaded: VaultBackend | undefined;
  const ensure = async (): Promise<VaultBackend> => {
    if (loaded) return loaded;
    const mod = await import('keytar');
    loaded = mod as unknown as VaultBackend;
    return loaded;
  };
  return {
    getPassword: async (s, a) => (await ensure()).getPassword(s, a),
    setPassword: async (s, a, v) => (await ensure()).setPassword(s, a, v),
    deletePassword: async (s, a) => (await ensure()).deletePassword(s, a),
    findCredentials: async (s) => (await ensure()).findCredentials(s),
  };
}

/**
 * Schema-version migration framework.
 *
 * Each migration takes an unknown object known to be at `from` version and
 * returns an object at `to` version. The runner chains migrations until the
 * target version is reached.
 *
 * v1.0 is the initial version; no migrations exist yet. This file establishes
 * the slot so future versions can plug in without touching call sites.
 */
import { CURRENT_SCHEMA_VERSION, type Flow } from './schema.js';
import { assertValidFlow } from './validate.js';

export interface Migration {
  from: string;
  to: string;
  migrate(value: unknown): unknown;
}

const MIGRATIONS: Migration[] = [
  // future: { from: "1.0", to: "1.1", migrate: (v) => ... }
];

export function migrateFlow(raw: unknown): Flow {
  if (raw === null || typeof raw !== 'object' || !('schemaVersion' in raw)) {
    throw new Error('Migration failed: input does not look like a Flow (missing schemaVersion).');
  }
  let current = raw as Record<string, unknown>;
  let version = String(current.schemaVersion);

  while (version !== CURRENT_SCHEMA_VERSION) {
    const next = MIGRATIONS.find((m) => m.from === version);
    if (!next) {
      throw new Error(
        `No migration path from schemaVersion=${version} to ${CURRENT_SCHEMA_VERSION}.`,
      );
    }
    current = next.migrate(current) as Record<string, unknown>;
    version = String(current.schemaVersion);
  }

  return assertValidFlow(current);
}

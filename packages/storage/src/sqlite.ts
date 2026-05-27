/**
 * Meta SQLite store. Holds project/flow/run rows and indexes. Flow body (steps
 * etc.) lives in `flow.json` on disk; the SQLite row carries metadata only.
 */
import Database, { type Database as DatabaseInstance } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  origin: 'recorded' | 'ai-generated' | 'mixed';
  schemaVersion: string;
  createdAt: string;
  updatedAt: string;
  diskPath: string;
}

export interface RunRow {
  id: string;
  flowId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: 'running' | 'success' | 'failure' | 'aborted';
  logPath: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL,
  schemaVersion TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  diskPath TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_flows_project ON flows(projectId);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  flowId TEXT NOT NULL REFERENCES flows(id),
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  outcome TEXT NOT NULL,
  logPath TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_flow ON runs(flowId);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(startedAt);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const META_DB_VERSION_KEY = 'db.schemaVersion';
const META_DB_VERSION_VALUE = '1';

export class MetaStore {
  private readonly db: DatabaseInstance;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    this.upsertMeta(META_DB_VERSION_KEY, META_DB_VERSION_VALUE);
  }

  close(): void {
    this.db.close();
  }

  // --- projects ---
  upsertProject(row: ProjectRow): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt`,
      )
      .run(row.id, row.name, row.createdAt, row.updatedAt);
  }

  listProjects(): ProjectRow[] {
    return this.db.prepare(`SELECT * FROM projects ORDER BY updatedAt DESC`).all() as ProjectRow[];
  }

  // --- flows ---
  upsertFlow(row: FlowRow): void {
    this.db
      .prepare(
        `INSERT INTO flows (id, projectId, name, description, origin, schemaVersion, createdAt, updatedAt, diskPath)
         VALUES (@id, @projectId, @name, @description, @origin, @schemaVersion, @createdAt, @updatedAt, @diskPath)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           description=excluded.description,
           origin=excluded.origin,
           updatedAt=excluded.updatedAt,
           diskPath=excluded.diskPath`,
      )
      .run(row);
  }

  listFlows(projectId?: string): FlowRow[] {
    if (projectId) {
      return this.db
        .prepare(`SELECT * FROM flows WHERE projectId = ? ORDER BY updatedAt DESC`)
        .all(projectId) as FlowRow[];
    }
    return this.db.prepare(`SELECT * FROM flows ORDER BY updatedAt DESC`).all() as FlowRow[];
  }

  getFlow(id: string): FlowRow | undefined {
    return this.db.prepare(`SELECT * FROM flows WHERE id = ?`).get(id) as FlowRow | undefined;
  }

  // --- runs ---
  createRun(row: RunRow): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, flowId, startedAt, endedAt, outcome, logPath)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.flowId, row.startedAt, row.endedAt, row.outcome, row.logPath);
  }

  finishRun(id: string, outcome: RunRow['outcome'], endedAt: string, logPath?: string): void {
    this.db
      .prepare(`UPDATE runs SET endedAt = ?, outcome = ?, logPath = ? WHERE id = ?`)
      .run(endedAt, outcome, logPath ?? null, id);
  }

  listRuns(flowId: string, limit = 50): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE flowId = ? ORDER BY startedAt DESC LIMIT ?`)
      .all(flowId, limit) as RunRow[];
  }

  // --- meta ---
  private upsertMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}

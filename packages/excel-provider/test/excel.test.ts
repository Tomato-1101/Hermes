import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { RunContext, StepHandler } from '@hermes/engine';
import type { Step } from '@hermes/ir';
import { ExcelProvider, createExcelProvider, parseRange } from '../src/index.js';
import { excelStepHandlers, registerExcelHandlers } from '../src/handlers.js';
import { HandlerRegistry } from '@hermes/engine';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hermes-excel-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build a fixture .xlsx with exceljs directly (independent of our provider). */
async function writeFixture(
  path: string,
  rows: (string | number)[][],
  sheetName = 'Sheet1',
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((row) => ws.addRow(row));
  await wb.xlsx.writeFile(path);
}

function ctxFor(provider: ExcelProvider, vars: Record<string, unknown> = {}): RunContext {
  return {
    flow: {} as never,
    vars,
    inputs: {},
    outputs: {},
    signal: new AbortController().signal,
    emit: () => {},
    providers: { excel: provider },
  };
}

function getHandler(type: string): StepHandler {
  const h = excelStepHandlers.find((h) => h.type === type);
  if (!h) throw new Error(`excel handler ${type} not found`);
  return h;
}

describe('parseRange', () => {
  it('parses a single cell', () => {
    expect(parseRange('B2')).toEqual({ c1: 2, r1: 2, c2: 2, r2: 2 });
  });
  it('parses a rectangular range', () => {
    expect(parseRange('A1:C3')).toEqual({ c1: 1, r1: 1, c2: 3, r2: 3 });
  });
  it('normalizes a reversed range and multi-letter columns', () => {
    expect(parseRange('C3:A1')).toEqual({ c1: 1, r1: 1, c2: 3, r2: 3 });
    expect(parseRange('Z1:AB2')).toEqual({ c1: 26, r1: 1, c2: 28, r2: 2 });
  });
});

describe('ExcelProvider', () => {
  it('reads cells from a fixture written by exceljs directly', async () => {
    const path = join(dir, 'fixture.xlsx');
    await writeFixture(path, [
      ['Name', 'Score'],
      ['Alice', 90],
      ['Bob', 75],
    ]);
    const p = createExcelProvider();
    await p.openWorkbook(path);
    expect(p.readCell(path, 'A1')).toBe('Name');
    expect(p.readCell(path, 'B2')).toBe(90);
    expect(p.readCell(path, 'A3')).toBe('Bob');
  });

  it('reads a 2-D range', async () => {
    const path = join(dir, 'fixture.xlsx');
    await writeFixture(path, [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    const p = createExcelProvider();
    await p.openWorkbook(path);
    expect(p.readRange(path, 'A1:B2')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('writes a cell and persists it to disk (reopened by a fresh provider)', async () => {
    const path = join(dir, 'out.xlsx');
    const p = createExcelProvider();
    await p.openWorkbook(path); // path does not exist → fresh workbook
    p.writeCell(path, 'A1', 'hello');
    p.writeCell(path, 'B1', 42);
    await p.save(path);

    const reopened = createExcelProvider();
    await reopened.openWorkbook(path);
    expect(reopened.readCell(path, 'A1')).toBe('hello');
    expect(reopened.readCell(path, 'B1')).toBe(42);
  });

  it('writeRange then readRange round-trips a 2-D array', async () => {
    const path = join(dir, 'grid.xlsx');
    const p = createExcelProvider();
    await p.openWorkbook(path);
    const grid = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    p.writeRange(path, 'A1', grid);
    await p.save(path);

    const reopened = createExcelProvider();
    await reopened.openWorkbook(path);
    expect(reopened.readRange(path, 'A1:C2')).toEqual(grid);
  });
});

describe('excel step handlers', () => {
  it('excel_open + excel_read pulls a cell into a variable', async () => {
    const path = join(dir, 'fixture.xlsx');
    await writeFixture(path, [['Title'], ['body']]);
    const p = createExcelProvider();
    const ctx = ctxFor(p);

    const open: Step = { id: 'o', type: 'excel_open', enabled: true, params: { path } };
    await getHandler('excel_open').execute(open, ctx);

    const read: Step = {
      id: 'r',
      type: 'excel_read',
      enabled: true,
      params: { path, cell: 'A2', into: 'cellVal' },
    };
    const res = await getHandler('excel_read').execute(read, ctx);
    expect(ctx.vars['cellVal']).toBe('body');
    expect(res.data).toEqual({ value: 'body' });
  });

  it('excel_write persists, and a relative path resolves against __hermes_assets_dir__', async () => {
    const p = createExcelProvider();
    const ctx = ctxFor(p, { __hermes_assets_dir__: dir });

    await getHandler('excel_open').execute(
      { id: 'o', type: 'excel_open', enabled: true, params: { path: 'rel.xlsx' } },
      ctx,
    );
    await getHandler('excel_write').execute(
      { id: 'w', type: 'excel_write', enabled: true, params: { path: 'rel.xlsx', cell: 'A1', value: 'persisted' } },
      ctx,
    );

    // A brand-new provider reading the absolute path proves it hit disk.
    const reopened = createExcelProvider();
    await reopened.openWorkbook(join(dir, 'rel.xlsx'));
    expect(reopened.readCell(join(dir, 'rel.xlsx'), 'A1')).toBe('persisted');
  });

  it('excel_range reads into a variable, and writes a 2-D array back', async () => {
    const path = join(dir, 'postal.xlsx');
    // Postal-code-sort style fixture: code + town, intentionally out of order.
    await writeFixture(path, [
      ['1500001', 'Jingumae'],
      ['1000001', 'Chiyoda'],
      ['1300001', 'Oshiage'],
    ]);
    const p = createExcelProvider();
    const ctx = ctxFor(p);
    await getHandler('excel_open').execute(
      { id: 'o', type: 'excel_open', enabled: true, params: { path } },
      ctx,
    );

    await getHandler('excel_range').execute(
      { id: 'rr', type: 'excel_range', enabled: true, params: { path, range: 'A1:B3', into: 'rows' } },
      ctx,
    );
    const rows = ctx.vars['rows'] as (string | number)[][];
    expect(rows).toHaveLength(3);

    // Sort by the postal code (column 0) ascending, then write back.
    const sorted = [...rows].sort((a, b) => Number(a[0]) - Number(b[0]));
    await getHandler('excel_range').execute(
      { id: 'rw', type: 'excel_range', enabled: true, params: { path, range: 'A1', values: sorted } },
      ctx,
    );

    const reopened = createExcelProvider();
    await reopened.openWorkbook(path);
    expect(reopened.readRange(path, 'A1:B3')).toEqual([
      ['1000001', 'Chiyoda'],
      ['1300001', 'Oshiage'],
      ['1500001', 'Jingumae'],
    ]);
  });

  it('throws a clear error when the excel provider is missing', async () => {
    const ctx = { ...ctxFor(createExcelProvider()), providers: {} } as RunContext;
    const step: Step = { id: 'x', type: 'excel_open', enabled: true, params: { path: 'a.xlsx' } };
    await expect(getHandler('excel_open').execute(step, ctx)).rejects.toThrow(
      /Excel provider not available/,
    );
  });

  it('registerExcelHandlers adds all four steps under the default layer', () => {
    const r = new HandlerRegistry();
    registerExcelHandlers(r);
    expect(r.get('excel_open')).toBeDefined();
    expect(r.get('excel_read')).toBeDefined();
    expect(r.get('excel_write')).toBeDefined();
    expect(r.get('excel_range')).toBeDefined();
  });
});

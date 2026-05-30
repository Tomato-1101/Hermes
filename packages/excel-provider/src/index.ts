/**
 * exceljs-backed Excel Provider.
 *
 * File-based .xlsx automation: no Excel application, no OS dependency, so it
 * runs and is unit-tested on macOS. The provider keeps each opened workbook in
 * memory keyed by its (resolved) path so a read-modify-write sequence within
 * one flow stays coherent; mutating operations flush back to disk immediately
 * (there is no separate save Step in Phase 1).
 *
 * The Engine sees this only through `ProviderBag.excel` (an opaque handle);
 * the handlers in ./handlers.ts downcast to the concrete class.
 */
import { access } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { ExcelProviderHandle } from '@hermes/engine';

/** The primitive values we surface to / accept from flow variables. */
export type ExcelCellValue = string | number | boolean | null;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Spreadsheet column letters → 1-based index ("A"→1, "Z"→26, "AA"→27). */
function colToNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

interface RangeBounds {
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}

/** Parse "A1" or "A1:C3" into 1-based column/row bounds. */
export function parseRange(range: string): RangeBounds {
  const cell = /^([A-Za-z]+)(\d+)$/;
  const [startRaw, endRaw] = range.split(':');
  const start = cell.exec((startRaw ?? '').trim());
  if (!start) throw new Error(`excel: invalid range '${range}'`);
  const c1 = colToNum(start[1]!);
  const r1 = Number(start[2]);
  if (!endRaw) return { c1, r1, c2: c1, r2: r1 };
  const end = cell.exec(endRaw.trim());
  if (!end) throw new Error(`excel: invalid range '${range}'`);
  const c2 = colToNum(end[1]!);
  const r2 = Number(end[2]);
  return {
    c1: Math.min(c1, c2),
    r1: Math.min(r1, r2),
    c2: Math.max(c1, c2),
    r2: Math.max(r1, r2),
  };
}

/** Normalise an exceljs cell value to a flow-friendly primitive. */
function cellToValue(raw: ExcelJS.CellValue): ExcelCellValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return raw;
  }
  if (raw instanceof Date) return raw.toISOString();
  const obj = raw as unknown as Record<string, unknown>;
  // Formula cell: prefer the cached result.
  if ('result' in obj) return cellToValue(obj['result'] as ExcelJS.CellValue);
  // Rich text: concatenate the runs.
  if ('richText' in obj && Array.isArray(obj['richText'])) {
    return (obj['richText'] as { text?: string }[]).map((r) => r.text ?? '').join('');
  }
  // Hyperlink: the display text.
  if ('text' in obj) return String(obj['text']);
  // Error cell or anything else: stringify.
  return String((obj as { error?: unknown }).error ?? raw);
}

export class ExcelProvider implements ExcelProviderHandle {
  readonly kind = 'excel' as const;
  private readonly workbooks = new Map<string, ExcelJS.Workbook>();

  /**
   * Load the workbook at `path` and keep it open. A non-existent path starts a
   * fresh workbook with one sheet (so a write-only flow can create a file).
   * Re-opening an already-open path is a no-op.
   */
  async openWorkbook(path: string): Promise<void> {
    if (this.workbooks.has(path)) return;
    const wb = new ExcelJS.Workbook();
    if (await fileExists(path)) {
      await wb.xlsx.readFile(path);
    } else {
      wb.addWorksheet('Sheet1');
    }
    this.workbooks.set(path, wb);
  }

  private workbook(path: string): ExcelJS.Workbook {
    const wb = this.workbooks.get(path);
    if (!wb) {
      throw new Error(`excel: workbook '${path}' is not open — run excel_open first`);
    }
    return wb;
  }

  private sheet(path: string, sheetName?: string): ExcelJS.Worksheet {
    const wb = this.workbook(path);
    const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
    if (!ws) {
      throw new Error(`excel: sheet '${sheetName ?? '(first)'}' not found in '${path}'`);
    }
    return ws;
  }

  readCell(path: string, cell: string, sheetName?: string): ExcelCellValue {
    return cellToValue(this.sheet(path, sheetName).getCell(cell).value);
  }

  writeCell(path: string, cell: string, value: ExcelCellValue, sheetName?: string): void {
    this.sheet(path, sheetName).getCell(cell).value = value;
  }

  readRange(path: string, range: string, sheetName?: string): ExcelCellValue[][] {
    const ws = this.sheet(path, sheetName);
    const { c1, r1, c2, r2 } = parseRange(range);
    const rows: ExcelCellValue[][] = [];
    for (let r = r1; r <= r2; r++) {
      const row: ExcelCellValue[] = [];
      for (let c = c1; c <= c2; c++) {
        row.push(cellToValue(ws.getCell(r, c).value));
      }
      rows.push(row);
    }
    return rows;
  }

  /** Write a 2-D array starting at the range's top-left cell. */
  writeRange(path: string, range: string, values: ExcelCellValue[][], sheetName?: string): void {
    const ws = this.sheet(path, sheetName);
    const { c1, r1 } = parseRange(range);
    values.forEach((row, i) => {
      row.forEach((val, j) => {
        ws.getCell(r1 + i, c1 + j).value = val;
      });
    });
  }

  /** Persist the in-memory workbook back to its path. */
  async save(path: string): Promise<void> {
    await this.workbook(path).xlsx.writeFile(path);
  }

  async dispose(): Promise<void> {
    this.workbooks.clear();
  }
}

/** Construct a fresh, empty Excel provider. */
export function createExcelProvider(): ExcelProvider {
  return new ExcelProvider();
}

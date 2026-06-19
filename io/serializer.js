/**
 * io/serializer.js
 * ================
 * Serialization and deserialization utilities.
 *
 * FORMATS SUPPORTED:
 *   CSV  — portable, opens in Excel/Sheets, loses formulas (display values only)
 *   JSON — full fidelity, preserves raw formulas + formats, proprietary
 *
 * WHY TWO FORMATS?
 *   CSV is the universal interchange format — any tool can open it.
 *   JSON preserves the spreadsheet's full state: if B1 = A1+1, the JSON
 *   saves "=A1+1" not "42". This means reloading a JSON file gives you
 *   back live formulas, not just static numbers.
 *   This is the same distinction Excel makes between .csv and .xlsx.
 *
 * VERSIONING:
 *   The JSON format includes a schema version field so future format
 *   changes can be handled with migration code. Good engineering practice.
 */

'use strict';

const SCHEMA_VERSION = '1.0';

const Serializer = {

  // ─── JSON ────────────────────────────────────────────────────────────────────

  /**
   * Serialize the full spreadsheet state to a JSON string.
   * Preserves: raw formulas, cell formats, sheet metadata.
   *
   * @param {CellStore}  store
   * @param {object}     meta   Optional sheet metadata (name, etc.)
   * @returns {string}   JSON string
   */
  toJSON(store, meta = {}) {
    const payload = {
      _schema:  SCHEMA_VERSION,
      _saved:   new Date().toISOString(),
      _engine:  'SheetEngine',
      meta: {
        name:    meta.name    || 'Untitled',
        author:  meta.author  || '',
        ...meta,
      },
      cells: store.toJSON(),
    };
    return JSON.stringify(payload, null, 2);
  },

  /**
   * Deserialize a JSON string and load it into the store.
   *
   * @param {string}     json
   * @param {CellStore}  store
   * @returns {{ ok: boolean, error: string|null, meta: object }}
   */
  fromJSON(json, store) {
    let payload;
    try {
      payload = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: 'Invalid JSON: ' + e.message, meta: {} };
    }

    // Version check
    if (payload._schema && payload._schema !== SCHEMA_VERSION) {
      console.warn(`SheetEngine: loading schema ${payload._schema}, current is ${SCHEMA_VERSION}`);
    }

    const cells = payload.cells || payload; // fallback: bare cells object
    try {
      store.fromJSON(cells);
      return { ok: true, error: null, meta: payload.meta || {} };
    } catch (e) {
      return { ok: false, error: 'Load error: ' + e.message, meta: {} };
    }
  },

  // ─── CSV ─────────────────────────────────────────────────────────────────────

  /**
   * Export the grid as a CSV string (display values, not formulas).
   *
   * @param {CellStore}  store
   * @param {number}     rows
   * @param {number}     cols
   * @returns {string}
   */
  toCSV(store, rows, cols) {
    return store.toCSV(rows, cols);
  },

  /**
   * Import CSV text into the store.
   * All imported values are treated as literals (no formula detection).
   *
   * @param {string}    csv
   * @param {CellStore} store
   * @returns {{ ok: boolean, count: number, error: string|null }}
   */
  fromCSV(csv, store) {
    try {
      const addrs = store.fromCSV(csv);
      return { ok: true, count: addrs.length, error: null };
    } catch (e) {
      return { ok: false, count: 0, error: e.message };
    }
  },

  // ─── CLIPBOARD ───────────────────────────────────────────────────────────────

  /**
   * Export a 2D address grid as tab-separated text (for system clipboard).
   * This is what Excel/Sheets paste when you paste into another app.
   *
   * @param {string[][]} addrs2d   2D array from selection.get2DAddrs()
   * @param {CellStore}  store
   * @returns {string}
   */
  toTSV(addrs2d, store) {
    return addrs2d
      .map(row => row.map(a => store.getDisplayValue(a)).join('\t'))
      .join('\n');
  },

  /**
   * Parse tab-separated text (from system clipboard) into cell entries.
   *
   * @param {string} tsv
   * @param {string} originAddr  Top-left cell to paste into
   * @returns {{ addr: string, raw: string }[]}
   */
  fromTSV(tsv, originAddr) {
    const origin = parseAddress(originAddr);
    if (!origin) return [];

    const entries = [];
    const lines   = tsv.split('\n');
    lines.forEach((line, r) => {
      const fields = line.split('\t');
      fields.forEach((val, c) => {
        if (val.trim() !== '') {
          entries.push({
            addr: makeAddress(origin.col + c, origin.row + r),
            raw:  val.trim(),
          });
        }
      });
    });
    return entries;
  },
};
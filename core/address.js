/**
 * core/address.js
 * ===============
 * All cell address operations: parsing, encoding, range expansion.
 *
 * Design: pure functions, no side effects, no DOM, no state.
 * Every other module imports from here — it's the foundation.
 *
 * Addressing scheme:
 *   Columns: A=0, B=1, ..., Z=25, AA=26, AB=27, ...  (base-26 bijective numeration)
 *   Rows:    1-indexed in display ("A1"), 0-indexed internally
 *
 * Why bijective (not regular base-26)?
 *   Regular base-26 has no "0" digit — "A" is both the first column and
 *   the representation of zero. Bijective numeration avoids this: digits
 *   are {A..Z} = {1..26}, so A=1, Z=26, AA=27. This matches Excel exactly.
 */

'use strict';

// ─── ADDRESS PARSING ──────────────────────────────────────────────────────────

/**
 * Parse a cell address string into {col, row} (both 0-indexed).
 * Handles multi-letter columns: "AA1", "ZZ100", etc.
 * Returns null for invalid input.
 *
 * Algorithm: treat column letters as a bijective base-26 number.
 *   "A"  = 1-1 = 0
 *   "B"  = 2-1 = 1
 *   "Z"  = 26-1 = 25
 *   "AA" = 26*1 + 1 - 1 = 26
 *
 * @param  {string} addr  e.g. "A1", "BC42"
 * @returns {{ col: number, row: number } | null}
 */
function parseAddress(addr) {
  if (typeof addr !== 'string') return null;
  const m = addr.trim().toUpperCase().match(/^([A-Z]{1,3})(\d{1,7})$/);
  if (!m) return null;

  let col = 0;
  for (let i = 0; i < m[1].length; i++) {
    col = col * 26 + (m[1].charCodeAt(i) - 64); // A=1, B=2...
  }
  col -= 1; // convert to 0-indexed

  const row = parseInt(m[2], 10) - 1; // convert to 0-indexed
  if (row < 0) return null;

  return { col, row };
}

/**
 * Encode {col, row} (0-indexed) back to "A1" string.
 *
 * Algorithm: bijective base-26 encoding.
 *   Repeatedly take (n-1) % 26, map to letter, then n = floor((n-1)/26).
 *   This is bijective: no leading zeros, "A"=1, "Z"=26, "AA"=27.
 *
 * @param  {number} col  0-indexed
 * @param  {number} row  0-indexed
 * @returns {string}
 */
function makeAddress(col, row) {
  if (col < 0 || row < 0) return '';
  let letters = '';
  let n = col + 1; // 1-indexed for bijective encoding
  while (n > 0) {
    const rem = (n - 1) % 26;               // 0..25
    letters = String.fromCharCode(65 + rem) + letters; // 'A'..'Z'
    n = Math.floor((n - 1) / 26);
  }
  return letters + (row + 1);
}

/**
 * Parse a range string "A1:C3" into its two corner addresses.
 * Returns null if the string isn't a valid range.
 *
 * @param  {string} range  e.g. "A1:C3"
 * @returns {{ from: {col,row}, to: {col,row} } | null}
 */
function parseRange(range) {
  if (typeof range !== 'string') return null;
  const parts = range.toUpperCase().split(':');
  if (parts.length !== 2) return null;
  const from = parseAddress(parts[0]);
  const to   = parseAddress(parts[1]);
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Expand a range string "A1:C3" into a flat array of cell addresses.
 * Handles inverted ranges (B3:A1 → same as A1:B3).
 *
 * @param  {string} range  e.g. "A1:C3"
 * @returns {string[]}     e.g. ["A1","B1","C1","A2","B2","C2","A3","B3","C3"]
 */
function expandRange(range) {
  const parsed = parseRange(range);
  if (!parsed) return [];

  const r1 = Math.min(parsed.from.row, parsed.to.row);
  const r2 = Math.max(parsed.from.row, parsed.to.row);
  const c1 = Math.min(parsed.from.col, parsed.to.col);
  const c2 = Math.max(parsed.from.col, parsed.to.col);

  const cells = [];
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      cells.push(makeAddress(c, r));
    }
  }
  return cells;
}

/**
 * Returns the column label only (no row number).
 * makeAddress(2, 0) → "C1" ; colLabel(2) → "C"
 */
function colLabel(col) {
  return makeAddress(col, 0).replace(/\d+$/, '');
}

/**
 * Returns true if the string looks like a valid cell address.
 */
function isAddress(str) {
  return parseAddress(str) !== null;
}

/**
 * Returns true if the string looks like a valid range.
 */
function isRange(str) {
  return parseRange(str) !== null;
}

/**
 * Given two addresses, return the smallest bounding range string.
 * e.g. boundingRange("C3", "A1") → "A1:C3"
 */
function boundingRange(addr1, addr2) {
  const a = parseAddress(addr1);
  const b = parseAddress(addr2);
  if (!a || !b) return addr1;
  const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row);
  const c1 = Math.min(a.col, b.col), c2 = Math.max(a.col, b.col);
  return makeAddress(c1, r1) + ':' + makeAddress(c2, r2);
}
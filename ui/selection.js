/**
 * ui/selection.js
 * ===============
 * Selection manager — tracks which cells are currently selected.
 *
 * SELECTION MODES:
 *   single     — one cell (most common: just click)
 *   range      — rectangular block (click + drag, or Shift+arrow)
 *   multi      — multiple ranges (Ctrl+click, not yet implemented in grid)
 *
 * DESIGN:
 * The selection is pure state — it doesn't touch the DOM.
 * The Renderer reads selection state and applies CSS classes.
 * This separation makes the selection logic testable without a browser.
 *
 * ANCHOR + ACTIVE MODEL:
 *   anchor — the cell where selection started (fixed during Shift+extend)
 *   active — the cell where the cursor is (moves during Shift+arrow)
 *   The selected range = bounding box of (anchor, active)
 */

'use strict';

class CellSelection {
  constructor() {
    /** Anchor cell: {col, row} — where selection started */
    this.anchor = { col: 0, row: 0 };

    /** Active cell: {col, row} — where keyboard cursor is */
    this.active = { col: 0, row: 0 };

    /** Whether we're in range-select mode (Shift held, drag, etc.) */
    this.isRange = false;

    this._listeners = [];
  }

  // ─── MUTATION ────────────────────────────────────────────────────────────────

  /**
   * Move to a single cell (collapses any existing range).
   */
  setCell(col, row) {
    this.anchor  = { col, row };
    this.active  = { col, row };
    this.isRange = false;
    this._notify();
  }

  /**
   * Extend the selection from anchor to (col, row).
   * Used for Shift+click and Shift+arrow key.
   */
  extendTo(col, row) {
    this.active  = { col, row };
    this.isRange = (col !== this.anchor.col || row !== this.anchor.row);
    this._notify();
  }

  /**
   * Move the active cell by (dc, dr) with optional range extension.
   */
  move(dc, dr, extend = false, maxCol = 999, maxRow = 999) {
    const newCol = Math.max(0, Math.min(maxCol, this.active.col + dc));
    const newRow = Math.max(0, Math.min(maxRow, this.active.row + dr));

    if (extend) {
      this.extendTo(newCol, newRow);
    } else {
      this.setCell(newCol, newRow);
    }
  }

  // ─── QUERIES ─────────────────────────────────────────────────────────────────

  /** Get the bounding rectangle of the current selection */
  get bounds() {
    return {
      colMin: Math.min(this.anchor.col, this.active.col),
      colMax: Math.max(this.anchor.col, this.active.col),
      rowMin: Math.min(this.anchor.row, this.active.row),
      rowMax: Math.max(this.anchor.row, this.active.row),
    };
  }

  /** Is a given (col, row) within the current selection? */
  contains(col, row) {
    const b = this.bounds;
    return col >= b.colMin && col <= b.colMax && row >= b.rowMin && row <= b.rowMax;
  }

  /** Is a given (col, row) the active (cursor) cell? */
  isActive(col, row) {
    return col === this.active.col && row === this.active.row;
  }

  /** Is a given column in the selected range? (for column header highlight) */
  colSelected(col) {
    const b = this.bounds;
    return col >= b.colMin && col <= b.colMax;
  }

  /** Is a given row in the selected range? (for row header highlight) */
  rowSelected(row) {
    const b = this.bounds;
    return row >= b.rowMin && row <= b.rowMax;
  }

  /** Address string of the active cell */
  get activeAddr() {
    return makeAddress(this.active.col, this.active.row);
  }

  /** Address string of the selected range */
  get rangeAddr() {
    if (!this.isRange) return this.activeAddr;
    return boundingRange(
      makeAddress(this.anchor.col, this.anchor.row),
      makeAddress(this.active.col, this.active.row)
    );
  }

  /** All addresses in the selected range */
  get selectedAddrs() {
    if (!this.isRange) return [this.activeAddr];
    return expandRange(this.rangeAddr);
  }

  /** Number of selected cells */
  get count() {
    const b = this.bounds;
    return (b.colMax - b.colMin + 1) * (b.rowMax - b.rowMin + 1);
  }

  // ─── CLIPBOARD HELPERS ───────────────────────────────────────────────────────

  /** Get selection as a 2D array of addresses */
  get2DAddrs() {
    const b = this.bounds;
    const rows = [];
    for (let r = b.rowMin; r <= b.rowMax; r++) {
      const row = [];
      for (let c = b.colMin; c <= b.colMax; c++) {
        row.push(makeAddress(c, r));
      }
      rows.push(row);
    }
    return rows;
  }

  // ─── LISTENERS ───────────────────────────────────────────────────────────────

  onChange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(f => f !== fn); };
  }

  _notify() {
    const payload = {
      active:     { ...this.active },
      anchor:     { ...this.anchor },
      isRange:    this.isRange,
      activeAddr: this.activeAddr,
      rangeAddr:  this.rangeAddr,
      count:      this.count,
    };
    this._listeners.forEach(fn => fn(payload));
  }
}
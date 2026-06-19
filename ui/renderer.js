/**
 * ui/renderer.js
 * ==============
 * Grid Renderer — builds and efficiently updates the spreadsheet DOM table.
 *
 * DESIGN PRINCIPLES:
 * ------------------
 * 1. Virtual cell tracking: each <td> element is stored in a 2D array
 *    for O(1) access by (row, col) without DOM queries.
 *
 * 2. Dirty-cell batching: instead of re-rendering the entire grid on
 *    every keystroke, only the cells flagged as dirty are updated.
 *    Uses requestAnimationFrame to batch multiple changes into one paint.
 *
 * 3. Separation of concerns: Renderer only touches the DOM. It gets
 *    data from CellStore and selection state from CellSelection.
 *    No business logic lives here.
 *
 * 4. Sticky headers: column and row headers use CSS position:sticky
 *    so they stay visible while scrolling — implemented in CSS,
 *    zero JS overhead.
 *
 * CELL CLASSES:
 *   .cell-number   — numeric value → right-aligned, blue
 *   .cell-formula  — computed formula result → teal
 *   .cell-text     — string value → left-aligned
 *   .cell-error    — error value → red
 *   .cell-selected — in current selection range
 *   .cell-active   — the active (cursor) cell
 *   .dep-glow      — cells that depend on the active cell
 *   .dep-source    — cells that the active cell reads from
 */

'use strict';

class GridRenderer {
  /**
   * @param {HTMLElement}   container  The scrollable grid container
   * @param {CellStore}     store
   * @param {CellSelection} selection
   * @param {{ rows: number, cols: number }} config
   */
  constructor(container, store, selection, config = {}) {
    this.container = container;
    this.store     = store;
    this.selection = selection;
    this.ROWS      = config.rows || 50;
    this.COLS      = config.cols || 20;

    /** @type {HTMLTableCellElement[][]} */
    this.cellEls = [];

    /** @type {Set<string>} Addresses needing re-render */
    this._dirtySet = new Set();
    this._rafPending = false;

    this._buildTable();
  }

  // ─── TABLE CONSTRUCTION ──────────────────────────────────────────────────────

  _buildTable() {
    const table = document.createElement('table');
    table.className = 'grid-table';
    table.setAttribute('role', 'grid');
    table.setAttribute('tabindex', '0');

    // ── Header row ──────────────────────────────────────────────────
    const thead = document.createElement('thead');
    const hrow  = document.createElement('tr');

    // Corner cell
    const corner = document.createElement('th');
    corner.className = 'corner-cell';
    corner.setAttribute('aria-label', 'Select all');
    hrow.appendChild(corner);

    for (let c = 0; c < this.COLS; c++) {
      const th = document.createElement('th');
      th.className     = 'col-header';
      th.dataset.col   = c;
      th.textContent   = colLabel(c);
      th.setAttribute('scope', 'col');
      hrow.appendChild(th);
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    // ── Body rows ────────────────────────────────────────────────────
    const tbody = document.createElement('tbody');

    for (let r = 0; r < this.ROWS; r++) {
      const tr = document.createElement('tr');
      tr.dataset.row = r;

      // Row header
      const rh = document.createElement('td');
      rh.className   = 'row-header';
      rh.dataset.row = r;
      rh.textContent = r + 1;
      rh.setAttribute('scope', 'row');
      tr.appendChild(rh);

      this.cellEls[r] = [];

      for (let c = 0; c < this.COLS; c++) {
        const td = document.createElement('td');
        td.className     = 'grid-cell';
        td.dataset.row   = r;
        td.dataset.col   = c;
        td.setAttribute('role', 'gridcell');
        td.setAttribute('tabindex', '-1');
        tr.appendChild(td);
        this.cellEls[r][c] = td;
      }

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    this.container.appendChild(table);
    this.table = table;

    // Expose for event delegation in Grid controller
    this.tbody  = tbody;
    this.thead  = thead;
  }

  // ─── CELL RENDERING ──────────────────────────────────────────────────────────

  /**
   * Schedule a cell for re-render (batched via rAF).
   */
  markDirty(addr) {
    this._dirtySet.add(addr.toUpperCase());
    if (!this._rafPending) {
      this._rafPending = true;
      requestAnimationFrame(() => this._flushDirty());
    }
  }

  /**
   * Mark a list of cells dirty.
   */
  markDirtyList(addrs) {
    addrs.forEach(a => this._dirtySet.add(a.toUpperCase()));
    if (!this._rafPending) {
      this._rafPending = true;
      requestAnimationFrame(() => this._flushDirty());
    }
  }

  /**
   * Immediately render all dirty cells (bypasses rAF).
   */
  _flushDirty() {
    this._rafPending = false;
    for (const addr of this._dirtySet) {
      this._renderCell(addr);
    }
    this._dirtySet.clear();
  }

  /**
   * Force-render a specific cell immediately.
   */
  renderCellNow(addr) {
    this._renderCell(addr.toUpperCase());
  }

  /**
   * Re-render every cell in the grid (used after bulk operations).
   */
  renderAll() {
    for (let r = 0; r < this.ROWS; r++) {
      for (let c = 0; c < this.COLS; c++) {
        this._renderCell(makeAddress(c, r));
      }
    }
  }

  /**
   * Internal: update a single cell's DOM element.
   */
  _renderCell(addr) {
    const pos = parseAddress(addr);
    if (!pos || pos.row >= this.ROWS || pos.col >= this.COLS) return;

    const td      = this.cellEls[pos.row][pos.col];
    if (!td) return;

    const cell    = this.store.get(addr);
    const display = this.store.getDisplayValue(addr);
    const fmt     = cell.format;

    // Content
    td.textContent = display;

    // Clear type classes
    td.classList.remove('cell-number', 'cell-formula', 'cell-text', 'cell-error', 'cell-bool');

    // Apply type class
    if (cell.error) {
      td.classList.add('cell-error');
    } else if (typeof cell.value === 'number') {
      td.classList.add(cell.formula ? 'cell-formula-num' : 'cell-number');
    } else if (cell.formula) {
      td.classList.add('cell-formula');
    } else if (cell.raw) {
      td.classList.add('cell-text');
    }

    // Apply format styles
    td.style.textAlign  = fmt.align || (typeof cell.value === 'number' ? 'right' : 'left');
    td.style.fontWeight = fmt.bold   ? 'bold'   : '';
    td.style.fontStyle  = fmt.italic ? 'italic' : '';
    td.style.color      = fmt.color  || '';
    td.style.background = fmt.bgColor || '';
  }

  // ─── SELECTION RENDERING ─────────────────────────────────────────────────────

  /**
   * Apply selection styling.
   * Called by the Grid controller whenever selection changes.
   */
  applySelection(selection) {
    // 1. Clear all selection classes
    this.table.querySelectorAll('.cell-selected, .cell-active, .col-header.col-active, .row-header.row-active')
      .forEach(el => el.classList.remove('cell-selected', 'cell-active', 'col-active', 'row-active'));

    const b = selection.bounds;

    // 2. Highlight cells in range
    for (let r = b.rowMin; r <= b.rowMax; r++) {
      for (let c = b.colMin; c <= b.colMax; c++) {
        const td = this.cellEls[r]?.[c];
        if (td) td.classList.add('cell-selected');
      }
    }

    // 3. Mark active cell
    const active = this.cellEls[selection.active.row]?.[selection.active.col];
    if (active) {
      active.classList.remove('cell-selected');
      active.classList.add('cell-active');
    }

    // 4. Highlight column headers
    for (let c = b.colMin; c <= b.colMax; c++) {
      const th = this.thead.querySelector(`th[data-col="${c}"]`);
      if (th) th.classList.add('col-active');
    }

    // 5. Highlight row headers
    for (let r = b.rowMin; r <= b.rowMax; r++) {
      const rh = this.tbody.querySelector(`td.row-header[data-row="${r}"]`);
      if (rh) rh.classList.add('row-active');
    }
  }

  /**
   * Show dependency highlights: cells read by the active cell (sources)
   * and cells that depend on it (consumers).
   */
  applyDepHighlights(activeAddr, store) {
    // Clear old dep highlights
    this.table.querySelectorAll('.dep-source, .dep-consumer')
      .forEach(el => el.classList.remove('dep-source', 'dep-consumer'));

    // Source cells: what the active cell reads from
    const deps = store.dag.getDirectDeps(activeAddr);
    deps.forEach(addr => {
      const pos = parseAddress(addr);
      if (!pos) return;
      const td = this.cellEls[pos.row]?.[pos.col];
      if (td) td.classList.add('dep-source');
    });

    // Consumer cells: what reads from the active cell
    const consumers = store.dag.getDirectDependents(activeAddr);
    consumers.forEach(addr => {
      const pos = parseAddress(addr);
      if (!pos) return;
      const td = this.cellEls[pos.row]?.[pos.col];
      if (td) td.classList.add('dep-consumer');
    });
  }

  /**
   * Flash a list of cells with an update animation.
   * Used to show cascade re-evaluation visually.
   */
  flashCells(addrs) {
    addrs.forEach(addr => {
      const pos = parseAddress(addr);
      if (!pos) return;
      const td = this.cellEls[pos.row]?.[pos.col];
      if (!td) return;
      td.classList.remove('cell-cascade');
      void td.offsetWidth; // force reflow for animation restart
      td.classList.add('cell-cascade');
      setTimeout(() => td.classList.remove('cell-cascade'), 700);
    });
  }

  // ─── SCROLL HELPERS ──────────────────────────────────────────────────────────

  /**
   * Scroll the active cell into view.
   */
  scrollToCell(col, row) {
    const td = this.cellEls[row]?.[col];
    if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ─── ACCESSORS ───────────────────────────────────────────────────────────────

  /** Get the <td> element for a given (col, row) */
  getTD(col, row) {
    return this.cellEls[row]?.[col] || null;
  }
}
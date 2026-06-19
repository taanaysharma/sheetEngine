/**
 * ui/grid.js
 * ==========
 * Grid Controller — the "controller" in Model-View-Controller.
 *
 * RESPONSIBILITIES:
 *   - Listen for keyboard and mouse events on the grid
 *   - Translate user intent (keystrokes, clicks) into:
 *       a) Selection changes (via CellSelection)
 *       b) Cell edits (via HistoryStack → CellStore)
 *   - Coordinate formula bar ↔ grid editing state
 *   - Manage the copy/paste clipboard
 *
 * EDITING STATE MACHINE:
 *
 *   ┌──────────┐  Enter/dblclick/type  ┌──────────┐
 *   │ NAVIGATE │─────────────────────▶ │  EDITING  │
 *   └──────────┘                       └──────────┘
 *        ▲                              │         │
 *        │     Enter/Tab (confirm)      │         │
 *        └──────────────────────────────┘         │
 *        │     Escape (cancel)                     │
 *        └─────────────────────────────────────────┘
 *
 * KEYBOARD MAP (navigate mode):
 *   Arrow keys   — move selection
 *   Shift+arrow  — extend selection
 *   Enter        — begin edit
 *   Delete/Bksp  — clear cell
 *   Ctrl+Z       — undo
 *   Ctrl+Y / Ctrl+Shift+Z — redo
 *   Ctrl+C       — copy
 *   Ctrl+V       — paste
 *   Ctrl+D       — fill down (active cell → fill selection)
 *   Tab          — move right
 *   Ctrl+Home    — go to A1
 *   Ctrl+End     — go to last used cell
 *   Any printable char — begin edit with that char
 *
 * KEYBOARD MAP (edit mode):
 *   Enter        — commit, move down
 *   Tab          — commit, move right
 *   Escape       — cancel edit
 *   Arrow keys   — insert cell ref into formula (when formula starts with '=')
 */

'use strict';

class Grid {
  /**
   * @param {object} opts
   * @param {HTMLElement}   opts.gridContainer  Scrollable container for table
   * @param {HTMLInputElement} opts.formulaBar  The formula input element
   * @param {HTMLInputElement} opts.cellRefInput  The cell-address box
   * @param {CellStore}     opts.store
   * @param {HistoryStack}  opts.history
   * @param {number}        opts.rows
   * @param {number}        opts.cols
   * @param {Function}      opts.onSelectionChange  Callback when selection moves
   */
  constructor(opts) {
    this.store     = opts.store;
    this.history   = opts.history;
    this.ROWS      = opts.rows || 50;
    this.COLS      = opts.cols || 20;
    this.formulaBar     = opts.formulaBar;
    this.cellRefInput   = opts.cellRefInput;
    this.onSelectionChange = opts.onSelectionChange || (() => {});

    this.selection = new CellSelection();
    this.renderer  = new GridRenderer(opts.gridContainer, this.store, this.selection, {
      rows: this.ROWS,
      cols: this.COLS,
    });

    // Edit state
    this._editing    = false;
    this._editOldRaw = '';

    // Clipboard: { addrs: string[][], values: string[][] }
    this._clipboard = null;

    this._bindEvents();
    this._bindSelectionListener();
    this._bindStoreListener();

    // Initial render and focus
    this.renderer.renderAll();
    this._navigate(0, 0);
  }

  // ─── NAVIGATION ──────────────────────────────────────────────────────────────

  /**
   * Navigate to (col, row), commit any active edit, update UI.
   */
  _navigate(col, row, extend = false) {
    col = Math.max(0, Math.min(this.COLS - 1, col));
    row = Math.max(0, Math.min(this.ROWS - 1, row));

    if (this._editing && !extend) this._commitEdit();

    if (extend) {
      this.selection.extendTo(col, row);
    } else {
      this.selection.setCell(col, row);
    }

    this.renderer.scrollToCell(col, row);
    // Focus the TD so keyboard events fire on the table
    const td = this.renderer.getTD(col, row);
    if (td) td.focus({ preventScroll: true });
  }

  // ─── EDITING ─────────────────────────────────────────────────────────────────

  _startEdit(initialChar = null) {
    if (this._editing) return;
    this._editing = true;

    const addr        = this.selection.activeAddr;
    const cell        = this.store.get(addr);
    this._editOldRaw  = cell.raw || '';

    // Populate formula bar
    if (initialChar !== null) {
      this.formulaBar.value = initialChar;
    } else {
      this.formulaBar.value = cell.raw || '';
    }

    this.formulaBar.focus();
    // Move cursor to end
    const len = this.formulaBar.value.length;
    this.formulaBar.setSelectionRange(len, len);
  }

  _commitEdit(navigateDir = null) {
    if (!this._editing) return;
    this._editing = false;

    const addr   = this.selection.activeAddr;
    const newRaw = this.formulaBar.value.trim();
    const oldRaw = this._editOldRaw;

    if (newRaw !== oldRaw) {
      const cmd = new CellEditCommand(this.store, addr, newRaw, oldRaw);
      this.history.push(cmd);
    }

    // Return focus to grid table
    const td = this.renderer.getTD(this.selection.active.col, this.selection.active.row);
    if (td) td.focus({ preventScroll: true });

    if (navigateDir) {
      const { col, row } = this.selection.active;
      if (navigateDir === 'down')  this._navigate(col, row + 1);
      if (navigateDir === 'right') this._navigate(col + 1, row);
      if (navigateDir === 'up')    this._navigate(col, row - 1);
    }
  }

  _cancelEdit() {
    if (!this._editing) return;
    this._editing = false;
    const cell = this.store.get(this.selection.activeAddr);
    this.formulaBar.value = cell.raw || '';
    const td = this.renderer.getTD(this.selection.active.col, this.selection.active.row);
    if (td) td.focus({ preventScroll: true });
  }

  _deleteActiveCell() {
    const addr = this.selection.activeAddr;
    const cell = this.store.get(addr);
    if (!cell.raw) return;
    const cmd = new CellEditCommand(this.store, addr, '', cell.raw);
    this.history.push(cmd);
    this.formulaBar.value = '';
  }

  _deleteSelection() {
    const addrs = this.selection.selectedAddrs;
    if (addrs.length === 0) return;
    const changes = addrs
      .filter(a => this.store.get(a).raw !== '')
      .map(a => ({ addr: a, newRaw: '', oldRaw: this.store.get(a).raw }));
    if (changes.length === 0) return;
    const cmd = new BulkEditCommand(this.store, changes, `Delete ${changes.length} cells`);
    this.history.push(cmd);
  }

  // ─── CLIPBOARD ───────────────────────────────────────────────────────────────

  _copy() {
    const rows2d = this.selection.get2DAddrs();
    const values = rows2d.map(row => row.map(a => this.store.getDisplayValue(a)));
    this._clipboard = { addrs: rows2d, values };

    // Also write to system clipboard as tab-separated text
    const text = values.map(row => row.join('\t')).join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  _paste() {
    if (!this._clipboard) return;
    const { addrs, values } = this._clipboard;

    const { col: tc, row: tr } = this.selection.active;
    const changes = [];

    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const destAddr  = makeAddress(tc + c, tr + r);
        const sourceAddr = addrs[r]?.[c];
        const newRaw    = sourceAddr
          ? (this.store.get(sourceAddr).raw || values[r][c])
          : values[r][c];
        const oldRaw = this.store.get(destAddr).raw;
        changes.push({ addr: destAddr, newRaw, oldRaw });
      }
    }

    if (changes.length > 0) {
      const cmd = new BulkEditCommand(this.store, changes, `Paste ${changes.length} cells`);
      this.history.push(cmd);
    }
  }

  _fillDown() {
    const { colMin, colMax, rowMin, rowMax } = this.selection.bounds;
    if (rowMax === rowMin) return; // nothing to fill

    const changes = [];
    for (let c = colMin; c <= colMax; c++) {
      const srcRaw = this.store.get(makeAddress(c, rowMin)).raw;
      if (!srcRaw) continue;
      for (let r = rowMin + 1; r <= rowMax; r++) {
        const addr = makeAddress(c, r);
        changes.push({ addr, newRaw: srcRaw, oldRaw: this.store.get(addr).raw });
      }
    }

    if (changes.length > 0) {
      const cmd = new BulkEditCommand(this.store, changes, 'Fill down');
      this.history.push(cmd);
    }
  }

  // ─── EVENT BINDING ───────────────────────────────────────────────────────────

  _bindEvents() {
    const table = this.renderer.table;

    // ── Mouse events on grid ────────────────────────────────────────
    table.addEventListener('mousedown', (e) => {
      const td = e.target.closest('td.grid-cell');
      if (!td) return;
      const col = parseInt(td.dataset.col);
      const row = parseInt(td.dataset.row);

      if (e.shiftKey) {
        this._navigate(col, row, true); // extend selection
      } else {
        this._navigate(col, row);
      }

      // Start drag-select
      const onMove = (me) => {
        const target = document.elementFromPoint(me.clientX, me.clientY)?.closest('td.grid-cell');
        if (!target) return;
        const c = parseInt(target.dataset.col);
        const r = parseInt(target.dataset.row);
        this.selection.extendTo(c, r);
        this.renderer.applySelection(this.selection);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    table.addEventListener('dblclick', (e) => {
      if (e.target.closest('td.grid-cell')) this._startEdit();
    });

    // ── Keyboard on table ────────────────────────────────────────────
    table.addEventListener('keydown', (e) => {
      if (this._editing) return;

      const { col, row } = this.selection.active;
      const extend = e.shiftKey;
      const ctrl   = e.ctrlKey || e.metaKey;

      switch (e.key) {
        // Navigation
        case 'ArrowUp':    e.preventDefault(); this._navigate(col, row - 1, extend); break;
        case 'ArrowDown':  e.preventDefault(); this._navigate(col, row + 1, extend); break;
        case 'ArrowLeft':  e.preventDefault(); this._navigate(col - 1, row, extend); break;
        case 'ArrowRight': e.preventDefault(); this._navigate(col + 1, row, extend); break;
        case 'Tab':
          e.preventDefault();
          this._navigate(col + (e.shiftKey ? -1 : 1), row);
          break;
        case 'Enter':
          e.preventDefault();
          this._startEdit();
          break;
        case 'Home':
          e.preventDefault();
          ctrl ? this._navigate(0, 0) : this._navigate(0, row);
          break;
        case 'End':
          e.preventDefault();
          ctrl ? this._navigate(this.COLS - 1, this.ROWS - 1) : this._navigate(this.COLS - 1, row);
          break;
        case 'PageDown':
          e.preventDefault();
          this._navigate(col, Math.min(this.ROWS - 1, row + 15));
          break;
        case 'PageUp':
          e.preventDefault();
          this._navigate(col, Math.max(0, row - 15));
          break;

        // Editing
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          this.selection.isRange ? this._deleteSelection() : this._deleteActiveCell();
          break;
        case 'F2':
          e.preventDefault();
          this._startEdit();
          break;

        // History
        case 'z': case 'Z':
          if (ctrl) { e.preventDefault(); e.shiftKey ? this.history.redo() : this.history.undo(); }
          break;
        case 'y': case 'Y':
          if (ctrl) { e.preventDefault(); this.history.redo(); }
          break;

        // Clipboard
        case 'c': case 'C':
          if (ctrl) { e.preventDefault(); this._copy(); }
          break;
        case 'v': case 'V':
          if (ctrl) { e.preventDefault(); this._paste(); }
          break;

        // Fill
        case 'd': case 'D':
          if (ctrl) { e.preventDefault(); this._fillDown(); }
          break;

        default:
          // Printable character → start editing
          if (e.key.length === 1 && !ctrl && !e.altKey) {
            this._startEdit(e.key);
          }
      }
    });

    // ── Formula bar events ───────────────────────────────────────────
    this.formulaBar.addEventListener('keydown', (e) => {
      if (!this._editing) return;
      if (e.key === 'Enter') { e.preventDefault(); this._commitEdit('down'); }
      if (e.key === 'Tab')   { e.preventDefault(); this._commitEdit('right'); }
      if (e.key === 'Escape'){ e.preventDefault(); this._cancelEdit(); }
    });

    this.formulaBar.addEventListener('focus', () => {
      if (!this._editing) this._startEdit();
    });

    // ── Cell ref box ─────────────────────────────────────────────────
    this.cellRefInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const addr = parseAddress(this.cellRefInput.value.toUpperCase().trim());
        if (addr) this._navigate(addr.col, addr.row);
        else this.cellRefInput.value = this.selection.activeAddr;
      }
    });
  }

  _bindSelectionListener() {
    this.selection.onChange((info) => {
      // Update renderer selection highlighting
      this.renderer.applySelection(this.selection);

      // Update dep highlights for active cell
      this.renderer.applyDepHighlights(info.activeAddr, this.store);

      // Update formula bar and cell ref
      const cell = this.store.get(info.activeAddr);
      this.formulaBar.value   = this._editing ? this.formulaBar.value : (cell.raw || '');
      this.cellRefInput.value = info.isRange ? info.rangeAddr : info.activeAddr;

      // Notify parent
      this.onSelectionChange(info, cell);
    });
  }

  _bindStoreListener() {
    this.store.on('change', ({ updated, cycleCells }) => {
      // Re-render updated cells
      this.renderer.markDirtyList(updated);

      // Flash cascade cells (exclude the directly edited one)
      const active = this.selection.activeAddr;
      const cascade = updated.filter(a => a !== active);
      if (cascade.length > 0 && cascade.length < 30) {
        // Small delay so the dirty render happens first
        setTimeout(() => this.renderer.flashCells(cascade), 50);
      }

      // Refresh formula bar if the active cell's value changed
      if (updated.includes(active) && !this._editing) {
        const cell = this.store.get(active);
        this.formulaBar.value = cell.raw || '';
      }
    });
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────────

  /** Programmatically navigate to a cell address */
  goTo(addr) {
    const pos = parseAddress(addr);
    if (pos) this._navigate(pos.col, pos.row);
  }

  /** Load demo data */
  loadDemo() {
    const entries = [
      // Section 1: Revenue model header
      { addr: 'A1', raw: 'SheetEngine — Financial Model Demo' },
      { addr: 'A2', raw: 'Month'    }, { addr: 'B2', raw: 'Revenue'  },
      { addr: 'C2', raw: 'COGS'     }, { addr: 'D2', raw: 'GrossProfit' },
      { addr: 'E2', raw: 'OpEx'     }, { addr: 'F2', raw: 'EBIT'     },
      { addr: 'G2', raw: 'TaxRate'  }, { addr: 'H2', raw: 'NetProfit' },

      // Data rows
      { addr: 'A3', raw: 'Jan' }, { addr: 'B3', raw: '420000'  }, { addr: 'C3', raw: '168000' }, { addr: 'D3', raw: '=B3-C3' }, { addr: 'E3', raw: '84000'  }, { addr: 'F3', raw: '=D3-E3' }, { addr: 'G3', raw: '0.25' }, { addr: 'H3', raw: '=F3*(1-G3)' },
      { addr: 'A4', raw: 'Feb' }, { addr: 'B4', raw: '385000'  }, { addr: 'C4', raw: '150000' }, { addr: 'D4', raw: '=B4-C4' }, { addr: 'E4', raw: '78000'  }, { addr: 'F4', raw: '=D4-E4' }, { addr: 'G4', raw: '0.25' }, { addr: 'H4', raw: '=F4*(1-G4)' },
      { addr: 'A5', raw: 'Mar' }, { addr: 'B5', raw: '510000'  }, { addr: 'C5', raw: '198000' }, { addr: 'D5', raw: '=B5-C5' }, { addr: 'E5', raw: '92000'  }, { addr: 'F5', raw: '=D5-E5' }, { addr: 'G5', raw: '0.25' }, { addr: 'H5', raw: '=F5*(1-G5)' },
      { addr: 'A6', raw: 'Apr' }, { addr: 'B6', raw: '470000'  }, { addr: 'C6', raw: '180000' }, { addr: 'D6', raw: '=B6-C6' }, { addr: 'E6', raw: '88000'  }, { addr: 'F6', raw: '=D6-E6' }, { addr: 'G6', raw: '0.25' }, { addr: 'H6', raw: '=F6*(1-G6)' },
      { addr: 'A7', raw: 'May' }, { addr: 'B7', raw: '550000'  }, { addr: 'C7', raw: '210000' }, { addr: 'D7', raw: '=B7-C7' }, { addr: 'E7', raw: '95000'  }, { addr: 'F7', raw: '=D7-E7' }, { addr: 'G7', raw: '0.25' }, { addr: 'H7', raw: '=F7*(1-G7)' },
      { addr: 'A8', raw: 'Jun' }, { addr: 'B8', raw: '610000'  }, { addr: 'C8', raw: '232000' }, { addr: 'D8', raw: '=B8-C8' }, { addr: 'E8', raw: '102000' }, { addr: 'F8', raw: '=D8-E8' }, { addr: 'G8', raw: '0.25' }, { addr: 'H8', raw: '=F8*(1-G8)' },

      // Aggregates
      { addr: 'A9',  raw: 'TOTAL'   },
      { addr: 'B9',  raw: '=SUM(B3:B8)'     }, { addr: 'C9', raw: '=SUM(C3:C8)' },
      { addr: 'D9',  raw: '=SUM(D3:D8)'     }, { addr: 'E9', raw: '=SUM(E3:E8)' },
      { addr: 'F9',  raw: '=SUM(F3:F8)'     }, { addr: 'H9', raw: '=SUM(H3:H8)' },
      { addr: 'A10', raw: 'AVERAGE'  },
      { addr: 'B10', raw: '=AVERAGE(B3:B8)' }, { addr: 'H10', raw: '=AVERAGE(H3:H8)' },
      { addr: 'A11', raw: 'BEST'     }, { addr: 'B11', raw: '=MAX(B3:B8)'  }, { addr: 'H11', raw: '=MAX(H3:H8)'  },
      { addr: 'A12', raw: 'WORST'    }, { addr: 'B12', raw: '=MIN(B3:B8)'  }, { addr: 'H12', raw: '=MIN(H3:H8)'  },

      // Section 2: Derived KPIs
      { addr: 'A14', raw: 'KEY METRICS' },
      { addr: 'A15', raw: 'Gross Margin %'   }, { addr: 'B15', raw: '=ROUND(D9/B9*100, 2)' },
      { addr: 'A16', raw: 'EBIT Margin %'    }, { addr: 'B16', raw: '=ROUND(F9/B9*100, 2)' },
      { addr: 'A17', raw: 'Net Margin %'     }, { addr: 'B17', raw: '=ROUND(H9/B9*100, 2)' },
      { addr: 'A18', raw: 'Avg Revenue/Mo'   }, { addr: 'B18', raw: '=ROUND(B9/6, 0)'       },
      { addr: 'A19', raw: 'Revenue StdDev'   }, { addr: 'B19', raw: '=ROUND(STDEV(B3:B8), 0)' },

      // Section 3: Nested formula demo
      { addr: 'A21', raw: 'FORMULA DEPTH TEST' },
      { addr: 'A22', raw: 'X'          }, { addr: 'B22', raw: '16' },
      { addr: 'A23', raw: 'SQRT(X)'    }, { addr: 'B23', raw: '=SQRT(B22)' },
      { addr: 'A24', raw: 'POWER(X,3)' }, { addr: 'B24', raw: '=POWER(B22, 3)' },
      { addr: 'A25', raw: 'IF test'    }, { addr: 'B25', raw: '=IF(B22>10, "Large", "Small")' },
      { addr: 'A26', raw: 'Chained'    }, { addr: 'B26', raw: '=ROUND(SQRT(POWER(B22,2)+POWER(B23,2)),4)' },
    ];

    this.history.beginBatch('Load demo');
    this.store.setBulk(entries);
    this.history.endBatch();

    this.renderer.renderAll();
    this._navigate(0, 0);
  }
}
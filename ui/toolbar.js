/**
 * ui/toolbar.js
 * =============
 * Toolbar — manages all header buttons, keyboard shortcut display,
 * and formula bar live hints.
 *
 * RESPONSIBILITIES:
 *   - Wire undo / redo buttons to HistoryStack
 *   - Wire file operations (demo, export CSV, import CSV, save JSON, load JSON)
 *   - Wire format buttons (bold, italic, align, number format)
 *   - Keep button disabled states in sync with HistoryStack
 *   - Show live formula hints as user types in formula bar
 *   - Display keyboard shortcut cheatsheet modal
 */

'use strict';

class Toolbar {
  /**
   * @param {object} opts
   * @param {CellStore}    opts.store
   * @param {HistoryStack} opts.history
   * @param {Grid}         opts.grid
   * @param {Function}     opts.getSelection  () => CellSelection
   * @param {HTMLElement}  opts.formulaBar
   */
  constructor(opts) {
    this.store        = opts.store;
    this.history      = opts.history;
    this.grid         = opts.grid;
    this.getSelection = opts.getSelection;
    this.formulaBar   = opts.formulaBar;

    this._bindToolbar();
    this._bindFormulaHints();
    this._bindModal();
    this._syncFromHistory();

    // Keep buttons in sync whenever history changes
    this.history.onChange(() => this._syncFromHistory());
  }

  // ─── TOOLBAR BUTTON WIRING ────────────────────────────────────────────────

  _bindToolbar() {
    const on = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    };

    // History
    on('btnUndo', () => { this.history.undo(); this.grid.renderer.renderAll(); });
    on('btnRedo', () => { this.history.redo(); this.grid.renderer.renderAll(); });

    // Data
    on('btnDemo',   () => { this.grid.loadDemo(); });
    on('btnClear',  () => {
      if (!confirm('Clear all cell data?')) return;
      this.store.clear();
      this.grid.renderer.renderAll();
      this.grid.goTo('A1');
    });

    // Export CSV
    on('btnExportCSV', () => {
      const csv  = this.store.toCSV(this.grid.ROWS, this.grid.COLS);
      this._download(csv, 'sheetengine.csv', 'text/csv');
    });

    // Import CSV
    const csvInput = document.getElementById('csvFileInput');
    on('btnImportCSV', () => csvInput?.click());
    if (csvInput) {
      csvInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          this.history.beginBatch('Import CSV');
          this.store.fromCSV(ev.target.result);
          this.history.endBatch();
          this.grid.renderer.renderAll();
          this.grid.goTo('A1');
        };
        reader.readAsText(file);
        csvInput.value = '';
      });
    }

    // Save JSON (full state with formulas preserved)
    on('btnSaveJSON', () => {
      const json = JSON.stringify(this.store.toJSON(), null, 2);
      this._download(json, 'sheetengine.json', 'application/json');
    });

    // Load JSON
    const jsonInput = document.getElementById('jsonFileInput');
    on('btnLoadJSON', () => jsonInput?.click());
    if (jsonInput) {
      jsonInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const obj = JSON.parse(ev.target.result);
            this.history.beginBatch('Load JSON');
            this.store.fromJSON(obj);
            this.history.endBatch();
            this.grid.renderer.renderAll();
            this.grid.goTo('A1');
          } catch (err) {
            alert('Invalid JSON file: ' + err.message);
          }
        };
        reader.readAsText(file);
        jsonInput.value = '';
      });
    }

    // Format buttons
    on('btnBold', () => {
      const sel  = this.getSelection();
      sel.selectedAddrs.forEach(addr => {
        const cell = this.store.get(addr);
        this.store.setFormat(addr, { bold: !cell.format.bold });
        this.grid.renderer.markDirty(addr);
      });
    });

    on('btnItalic', () => {
      const sel  = this.getSelection();
      sel.selectedAddrs.forEach(addr => {
        const cell = this.store.get(addr);
        this.store.setFormat(addr, { italic: !cell.format.italic });
        this.grid.renderer.markDirty(addr);
      });
    });

    on('btnAlignLeft',   () => this._applyAlign('left'));
    on('btnAlignCenter', () => this._applyAlign('center'));
    on('btnAlignRight',  () => this._applyAlign('right'));

    // Number format selectors
    on('btnFmtGeneral', () => this._applyFormat({ type: 'general' }));
    on('btnFmtNumber',  () => this._applyFormat({ type: 'number',  decimals: 2 }));
    on('btnFmtCurrency',() => this._applyFormat({ type: 'currency' }));
    on('btnFmtPercent', () => this._applyFormat({ type: 'percentage', decimals: 1 }));

    // Help / keyboard shortcuts
    on('btnHelp', () => document.getElementById('shortcutsModal')?.classList.remove('hidden'));
  }

  _applyAlign(align) {
    const sel = this.getSelection();
    sel.selectedAddrs.forEach(addr => {
      this.store.setFormat(addr, { align });
      this.grid.renderer.markDirty(addr);
    });
  }

  _applyFormat(fmt) {
    const sel = this.getSelection();
    sel.selectedAddrs.forEach(addr => {
      this.store.setFormat(addr, fmt);
      this.grid.renderer.markDirty(addr);
    });
  }

  // ─── SYNC BUTTON STATE ────────────────────────────────────────────────────

  _syncFromHistory() {
    const undoBtn = document.getElementById('btnUndo');
    const redoBtn = document.getElementById('btnRedo');
    if (undoBtn) undoBtn.disabled = !this.history.canUndo;
    if (redoBtn) redoBtn.disabled = !this.history.canRedo;

    // Update undo/redo tooltips with action names
    const last = this.history.lastCommand;
    if (undoBtn && last) undoBtn.title = `Undo: ${last.describe}`;
    else if (undoBtn)    undoBtn.title = 'Undo (Ctrl+Z)';
  }

  // ─── FORMULA BAR HINTS ───────────────────────────────────────────────────

  _bindFormulaHints() {
    const hintsEl = document.getElementById('formulaHints');
    if (!this.formulaBar || !hintsEl) return;

    // All known function signatures for autocomplete hints
    const FN_HINTS = {
      'SUM':        'SUM(range)  →  number',
      'AVERAGE':    'AVERAGE(range)  →  mean',
      'MIN':        'MIN(range)  →  smallest',
      'MAX':        'MAX(range)  →  largest',
      'COUNT':      'COUNT(range)  →  count of numbers',
      'COUNTA':     'COUNTA(range)  →  count of non-empty',
      'IF':         'IF(condition, value_if_true, value_if_false)',
      'IFERROR':    'IFERROR(value, fallback_if_error)',
      'ROUND':      'ROUND(number, decimal_places)',
      'ROUNDUP':    'ROUNDUP(number, decimal_places)',
      'ROUNDDOWN':  'ROUNDDOWN(number, decimal_places)',
      'ABS':        'ABS(number)  →  absolute value',
      'SQRT':       'SQRT(number)  →  square root',
      'POWER':      'POWER(base, exponent)  →  base^exp',
      'MOD':        'MOD(number, divisor)  →  remainder',
      'LOG':        'LOG(number, base)  →  logarithm',
      'CONCAT':     'CONCAT(text1, text2, ...)  →  joined string',
      'LEFT':       'LEFT(text, n)  →  first n chars',
      'RIGHT':      'RIGHT(text, n)  →  last n chars',
      'MID':        'MID(text, start, length)',
      'LEN':        'LEN(text)  →  character count',
      'UPPER':      'UPPER(text)  →  ALL CAPS',
      'LOWER':      'LOWER(text)  →  all lowercase',
      'TRIM':       'TRIM(text)  →  remove extra spaces',
      'SUBSTITUTE': 'SUBSTITUTE(text, find, replace)',
      'TEXT':       'TEXT(number, "0.00")  →  formatted string',
      'VLOOKUP':    'VLOOKUP(value, table_range, col_index)  →  matched row value',
      'MATCH':      'MATCH(value, range)  →  position',
      'INDEX':      'INDEX(range, row, col)  →  cell value',
      'STDEV':      'STDEV(range)  →  standard deviation',
      'MEDIAN':     'MEDIAN(range)  →  middle value',
      'PRODUCT':    'PRODUCT(range)  →  multiply all',
      'LARGE':      'LARGE(range, k)  →  k-th largest',
      'SMALL':      'SMALL(range, k)  →  k-th smallest',
      'RANK':       'RANK(value, range)  →  rank position',
      'AND':        'AND(cond1, cond2, ...)  →  1 if all true',
      'OR':         'OR(cond1, cond2, ...)  →  1 if any true',
      'NOT':        'NOT(value)  →  inverts boolean',
      'NOW':        'NOW()  →  current datetime',
      'TODAY':      'TODAY()  →  current date',
      'PI':         'PI()  →  3.14159265…',
      'RAND':       'RAND()  →  random 0 to 1',
      'RANDBETWEEN':'RANDBETWEEN(low, high)  →  random integer',
      'SIN':        'SIN(radians)',
      'COS':        'COS(radians)',
      'TAN':        'TAN(radians)',
      'DEGREES':    'DEGREES(radians)  →  convert to degrees',
      'RADIANS':    'RADIANS(degrees)  →  convert to radians',
    };

    this.formulaBar.addEventListener('input', () => {
      const raw   = this.formulaBar.value;
      hintsEl.textContent = '';

      if (!raw.startsWith('=')) return;

      // Find the function name being typed: last IDENT before cursor
      const cursor = this.formulaBar.selectionStart;
      const before = raw.slice(1, cursor); // strip '='
      const fnMatch = before.match(/([A-Z_][A-Z0-9_]*)(?:\(([^)]*))?$/i);

      if (fnMatch) {
        const name = fnMatch[1].toUpperCase();
        const hint = FN_HINTS[name];
        if (hint) { hintsEl.textContent = hint; return; }
      }

      // Range size hint
      const rangeMatch = raw.match(/([A-Z]+\d+):([A-Z]+\d+)/i);
      if (rangeMatch) {
        const cells = expandRange(rangeMatch[0]);
        hintsEl.textContent = `range: ${cells.length} cells (${rangeMatch[0]})`;
        return;
      }

      // Operator hint
      if (raw.match(/[+\-*/^]/)) {
        hintsEl.textContent = 'Tip: use * for multiply, ^ for power, / for divide';
      }
    });
  }

  // ─── MODAL ───────────────────────────────────────────────────────────────

  _bindModal() {
    const modal   = document.getElementById('shortcutsModal');
    const closeBtn = document.getElementById('closeShortcuts');
    if (!modal) return;

    closeBtn?.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });

    // Also close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
      }
    });
  }

  // ─── UTILS ───────────────────────────────────────────────────────────────

  _download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
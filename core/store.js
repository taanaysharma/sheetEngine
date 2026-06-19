/**
 * core/store.js
 * =============
 * CellStore — the central in-memory database for all cell data.
 *
 * RESPONSIBILITIES:
 *   1. Store raw input and computed value for every non-empty cell
 *   2. Keep the DependencyGraph in sync as cells are edited
 *   3. Trigger re-evaluation in topological order when a cell changes
 *   4. Track cell metadata: format, alignment, style
 *   5. Emit change events for UI to subscribe to
 *
 * CELL RECORD SCHEMA:
 *   {
 *     raw:      string,           // what the user typed: "=SUM(A1:A5)" or "42" or "hello"
 *     value:    number|string,    // computed result shown in cell
 *     formula:  string|null,      // non-null only if raw starts with '='
 *     format:   CellFormat,       // number format, alignment, etc.
 *     error:    string|null,      // set if value is an error string
 *   }
 *
 * EVALUATION FLOW (when user edits cell X):
 *   1. extractRefs(raw) → deps[]          — parse formula for cell refs
 *   2. dag.update(X, deps)                — update dependency graph
 *   3. dag.getAllDependents(X) → affected  — BFS: find all downstream cells
 *   4. dag.topoSort([X, ...affected])     — Kahn's algorithm: safe eval order
 *   5. evaluate each cell in order        — tree-walking evaluator
 *   6. mark cycle cells with #CYCLE!      — cells not in topo order
 *   7. emit 'change' event with updated[] — UI re-renders changed cells
 */

'use strict';

// ─── CELL FORMAT ─────────────────────────────────────────────────────────────

const FormatType = Object.freeze({
  GENERAL:    'general',
  NUMBER:     'number',
  CURRENCY:   'currency',
  PERCENTAGE: 'percentage',
  TEXT:       'text',
  DATE:       'date',
});

class CellFormat {
  constructor() {
    this.type       = FormatType.GENERAL;
    this.decimals   = null;   // null = auto
    this.prefix     = '';
    this.suffix     = '';
    this.align      = null;   // null = auto (numbers right, text left)
    this.bold       = false;
    this.italic     = false;
    this.color      = null;   // CSS color string or null
    this.bgColor    = null;
  }

  static fromType(type, opts = {}) {
    const f = new CellFormat();
    f.type = type;
    Object.assign(f, opts);
    return f;
  }
}

// ─── EVENT EMITTER (tiny, no dependencies) ───────────────────────────────────

class EventEmitter {
  constructor() { this._listeners = {}; }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => this.off(event, fn); // returns unsubscribe fn
  }

  off(event, fn) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(f => f !== fn);
  }

  emit(event, ...args) {
    (this._listeners[event] || []).forEach(fn => fn(...args));
  }
}

// ─── CELL STORE ──────────────────────────────────────────────────────────────

class CellStore extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, {raw,value,formula,format,error}>} */
    this.cells = new Map();

    /** @type {DependencyGraph} */
    this.dag = new DependencyGraph();

    // Bind getCellValue so it can be passed as a callback
    this._getCellValue = (addr) => {
      const cell = this.cells.get(addr.toUpperCase());
      if (!cell) return null;
      return cell.value !== undefined ? cell.value : null;
    };
  }

  // ─── CORE MUTATION ───────────────────────────────────────────────────────────

  /**
   * Set a cell's raw content and cascade re-evaluation.
   *
   * @param {string} addr   e.g. "A1"
   * @param {string} raw    raw user input
   * @returns {{ updated: string[], cycleCells: string[], topoOrder: string[] }}
   */
  set(addr, raw) {
    addr = addr.toUpperCase().trim();
    raw  = (raw ?? '').trim();

    if (raw === '') {
      return this._clearCell(addr);
    }

    // Step 1: extract dependencies from formula
    const deps = extractRefs(raw);

    // Step 2: update DAG (removes old edges, adds new ones)
    this.dag.update(addr, deps);

    // Step 3: evaluate this cell immediately
    const value   = evaluateFormula(raw, this._getCellValue);
    const isForm  = raw.startsWith('=');
    const isErr   = typeof value === 'string' && value.startsWith('#');

    const existing = this.cells.get(addr);
    this.cells.set(addr, {
      raw,
      value,
      formula: isForm ? raw : null,
      format:  existing?.format ?? new CellFormat(),
      error:   isErr ? value : null,
    });

    // Step 4: find all transitively affected cells
    const downstream = this.dag.getAllDependents(addr);
    const affected   = [addr, ...downstream];

    // Step 5: topological sort
    const { order, hasCycle, cycleCells } = this.dag.topoSort(affected);

    // Step 6: re-evaluate in topological order (skip addr — already done)
    for (const cell of order) {
      if (cell === addr) continue;
      const c = this.cells.get(cell);
      if (!c) continue;
      const newVal    = evaluateFormula(c.raw, this._getCellValue);
      c.value         = newVal;
      c.error         = (typeof newVal === 'string' && newVal.startsWith('#')) ? newVal : null;
    }

    // Step 7: mark cycle cells
    for (const cell of cycleCells) {
      const c = this.cells.get(cell);
      if (c) { c.value = '#CYCLE!'; c.error = '#CYCLE!'; }
    }

    const result = { updated: order, cycleCells, topoOrder: order };
    this.emit('change', result);
    return result;
  }

  /**
   * Clear a cell and re-evaluate dependents.
   * @private
   */
  _clearCell(addr) {
    const hadCell = this.cells.has(addr);
    this.cells.delete(addr);
    this.dag.remove(addr);

    const downstream = this.dag.getAllDependents(addr);
    const { order, cycleCells } = this.dag.topoSort(downstream);

    for (const cell of order) {
      const c = this.cells.get(cell);
      if (!c) continue;
      c.value = evaluateFormula(c.raw, this._getCellValue);
      c.error = (typeof c.value === 'string' && c.value.startsWith('#')) ? c.value : null;
    }

    const result = { updated: hadCell ? [addr, ...order] : order, cycleCells, topoOrder: order };
    this.emit('change', result);
    return result;
  }

  // ─── FORMAT ──────────────────────────────────────────────────────────────────

  /**
   * Update a cell's format without changing its value.
   * @param {string} addr
   * @param {Partial<CellFormat>} formatOpts
   */
  setFormat(addr, formatOpts) {
    addr = addr.toUpperCase();
    const cell = this.cells.get(addr);
    if (!cell) return;
    Object.assign(cell.format, formatOpts);
    this.emit('format', { addr });
  }

  // ─── QUERIES ─────────────────────────────────────────────────────────────────

  /**
   * Get a cell's full record. Returns a default empty record for missing cells.
   */
  get(addr) {
    const cell = this.cells.get(addr.toUpperCase());
    if (cell) return cell;
    return { raw: '', value: '', formula: null, format: new CellFormat(), error: null };
  }

  /**
   * Get just the computed value of a cell.
   */
  getValue(addr) {
    return this._getCellValue(addr.toUpperCase());
  }

  /**
   * Get formatted display value for a cell.
   * Applies number format, prefix/suffix, etc.
   */
  getDisplayValue(addr) {
    const cell = this.get(addr);
    const v    = cell.value;

    if (v === null || v === undefined || v === '') return '';
    if (cell.error) return cell.error;

    const fmt = cell.format;

    switch (fmt.type) {
      case FormatType.NUMBER: {
        const n = parseFloat(v);
        if (isNaN(n)) return String(v);
        const decimals = fmt.decimals ?? 2;
        return fmt.prefix + n.toFixed(decimals) + fmt.suffix;
      }
      case FormatType.CURRENCY: {
        const n = parseFloat(v);
        if (isNaN(n)) return String(v);
        return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      case FormatType.PERCENTAGE: {
        const n = parseFloat(v);
        if (isNaN(n)) return String(v);
        const decimals = fmt.decimals ?? 1;
        return (n * 100).toFixed(decimals) + '%';
      }
      default: {
        if (typeof v === 'number') {
          // Auto: trim trailing zeros, max 8 decimal places
          return parseFloat(v.toFixed(8)).toString();
        }
        return String(v);
      }
    }
  }

  // ─── BULK OPERATIONS ─────────────────────────────────────────────────────────

  /**
   * Set multiple cells at once.
   * More efficient than calling set() in a loop — only emits one change event.
   */
  setBulk(entries) {
    // entries: [{addr, raw}, ...]
    const allUpdated = new Set();

    for (const { addr, raw } of entries) {
      const a = addr.toUpperCase();
      if (!raw || raw.trim() === '') {
        this.cells.delete(a);
        this.dag.remove(a);
        allUpdated.add(a);
        continue;
      }
      const deps  = extractRefs(raw);
      this.dag.update(a, deps);
      const value = evaluateFormula(raw, this._getCellValue);
      const existing = this.cells.get(a);
      this.cells.set(a, {
        raw: raw.trim(),
        value,
        formula: raw.startsWith('=') ? raw : null,
        format: existing?.format ?? new CellFormat(),
        error: (typeof value === 'string' && value.startsWith('#')) ? value : null,
      });
      allUpdated.add(a);
    }

    // Re-evaluate all dependents
    const affected = [...allUpdated];
    for (const a of allUpdated) {
      this.dag.getAllDependents(a).forEach(d => affected.push(d));
    }

    const unique = [...new Set(affected)];
    const { order, cycleCells } = this.dag.topoSort(unique);

    for (const cell of order) {
      if (allUpdated.has(cell)) continue; // already evaluated
      const c = this.cells.get(cell);
      if (!c) continue;
      c.value = evaluateFormula(c.raw, this._getCellValue);
      c.error = (typeof c.value === 'string' && c.value.startsWith('#')) ? c.value : null;
    }

    for (const cell of cycleCells) {
      const c = this.cells.get(cell);
      if (c) { c.value = '#CYCLE!'; c.error = '#CYCLE!'; }
    }

    const result = { updated: order, cycleCells, topoOrder: order };
    this.emit('change', result);
    return result;
  }

  /**
   * Clear all cells.
   */
  clear() {
    this.cells.clear();
    this.dag = new DependencyGraph();
    this.emit('change', { updated: [], cycleCells: [], topoOrder: [] });
  }

  // ─── SERIALIZATION ───────────────────────────────────────────────────────────

  /**
   * Export all non-empty cells as a compact JSON object for save/load.
   * Only exports raw content — values are recomputed on load.
   */
  toJSON() {
    const obj = {};
    for (const [addr, cell] of this.cells) {
      obj[addr] = { raw: cell.raw };
      // Persist non-default format
      const f = cell.format;
      if (f.type !== FormatType.GENERAL || f.bold || f.italic || f.color || f.bgColor) {
        obj[addr].format = { ...f };
      }
    }
    return obj;
  }

  /**
   * Load from a JSON object (produced by toJSON()).
   */
  fromJSON(obj) {
    this.clear();
    const entries = Object.entries(obj).map(([addr, data]) => ({
      addr,
      raw: data.raw || '',
    }));
    this.setBulk(entries);
    // Restore formats
    for (const [addr, data] of Object.entries(obj)) {
      if (data.format) {
        this.setFormat(addr, data.format);
      }
    }
  }

  /**
   * Export as CSV.
   * @param {number} rows
   * @param {number} cols
   */
  toCSV(rows, cols) {
    const lines = [];
    for (let r = 0; r < rows; r++) {
      const fields = [];
      for (let c = 0; c < cols; c++) {
        const v = this.getDisplayValue(makeAddress(c, r));
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          fields.push('"' + s.replace(/"/g, '""') + '"');
        } else {
          fields.push(s);
        }
      }
      // Trim trailing empty fields
      while (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
      if (fields.length > 0) lines.push(fields.join(','));
    }
    return lines.join('\n');
  }

  /**
   * Import CSV text.
   * @param {string} text
   * @returns {string[]} Addresses of imported cells
   */
  fromCSV(text) {
    const lines   = text.split(/\r?\n/);
    const entries = [];

    for (let r = 0; r < lines.length; r++) {
      const fields = this._parseCSVLine(lines[r]);
      for (let c = 0; c < fields.length; c++) {
        if (fields[c] !== '') {
          entries.push({ addr: makeAddress(c, r), raw: fields[c] });
        }
      }
    }

    this.setBulk(entries);
    return entries.map(e => e.addr);
  }

  _parseCSVLine(line) {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inQuote) { inQuote = true; continue; }
      if (ch === '"' && inQuote) {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
        continue;
      }
      if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur);
    return fields;
  }

  // ─── STATS ───────────────────────────────────────────────────────────────────

  stats() {
    let formulas = 0, errors = 0;
    for (const cell of this.cells.values()) {
      if (cell.formula) formulas++;
      if (cell.error)   errors++;
    }
    return {
      totalCells: this.cells.size,
      formulas,
      errors,
      dag: this.dag.stats(),
    };
  }
}
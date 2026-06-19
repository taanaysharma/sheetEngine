/**
 * ui/sidebar.js
 * =============
 * Sidebar Panel — live dependency inspector and cell metadata viewer.
 *
 * PANELS:
 *   1. Cell Info     — raw, value, type, format of selected cell
 *   2. Depends On    — direct cells this formula reads (clickable)
 *   3. Dependents    — cells that will recompute when this changes
 *   4. DAG Insight   — cascade depth, topological order preview
 *   5. Functions     — searchable reference panel
 *   6. History       — last N undo actions
 */

'use strict';

class Sidebar {
  /**
   * @param {HTMLElement}  container   The sidebar DOM element
   * @param {CellStore}    store
   * @param {HistoryStack} history
   * @param {Function}     onNavigate  (addr) => void — called when user clicks a dep chip
   */
  constructor(container, store, history, onNavigate) {
    this.container  = container;
    this.store      = store;
    this.history    = history;
    this.onNavigate = onNavigate;

    this._currentAddr = 'A1';
    this._buildDOM();
    this._bindEvents();
  }

  // ─── DOM CONSTRUCTION ────────────────────────────────────────────────────────

  _buildDOM() {
    this.container.innerHTML = `
      <!-- ── CELL INFO ─────────────────────────────────────── -->
      <div class="sb-section" id="sbCellInfo">
        <div class="sb-section-title">Cell Inspector</div>
        <div class="sb-row"><span class="sb-key">Address</span><span class="sb-val mono" id="sbAddr">A1</span></div>
        <div class="sb-row"><span class="sb-key">Raw</span><span class="sb-val mono ellipsis" id="sbRaw">—</span></div>
        <div class="sb-row"><span class="sb-key">Value</span><span class="sb-val mono" id="sbValue">—</span></div>
        <div class="sb-row"><span class="sb-key">Type</span><span class="sb-val" id="sbType"><span class="type-badge">empty</span></span></div>
        <div class="sb-row"><span class="sb-key">Depth</span><span class="sb-val mono" id="sbDepth">0</span></div>
      </div>

      <!-- ── DEPENDENCY GRAPH ──────────────────────────────── -->
      <div class="sb-section" id="sbDeps">
        <div class="sb-section-title">
          Reads From
          <span class="sb-count" id="sbDepsOnCount">0</span>
        </div>
        <div class="dep-chips" id="sbDepsOn"></div>
      </div>

      <div class="sb-section" id="sbDependents">
        <div class="sb-section-title">
          Read By
          <span class="sb-count" id="sbDepsOfCount">0</span>
        </div>
        <div class="dep-chips" id="sbDepsOf"></div>
      </div>

      <!-- ── DAG INSIGHT ───────────────────────────────────── -->
      <div class="sb-section" id="sbDag">
        <div class="sb-section-title">DAG Cascade</div>
        <div class="dag-insight" id="sbDagInsight">
          Select a formula cell to see its dependency cascade.
        </div>
        <div class="topo-chain" id="sbTopoChain"></div>
      </div>

      <!-- ── GRAPH STATS ───────────────────────────────────── -->
      <div class="sb-section" id="sbStats">
        <div class="sb-section-title">Sheet Stats</div>
        <div class="stats-grid" id="sbStatsGrid"></div>
      </div>

      <!-- ── FUNCTION REFERENCE ────────────────────────────── -->
      <div class="sb-section" id="sbFunctions">
        <div class="sb-section-title">Function Reference</div>
        <input class="fn-search" id="fnSearch" placeholder="Search functions…" />
        <div class="fn-list" id="fnList"></div>
      </div>

      <!-- ── HISTORY ───────────────────────────────────────── -->
      <div class="sb-section" id="sbHistory">
        <div class="sb-section-title">
          Action History
          <span class="sb-count" id="sbHistCount">0</span>
        </div>
        <div class="hist-list" id="sbHistList"></div>
      </div>
    `;

    // Populate function reference
    this._buildFnList();
  }

  // ─── UPDATE ──────────────────────────────────────────────────────────────────

  /**
   * Refresh the sidebar for the newly selected cell.
   * Called by Grid controller on every selection change.
   */
  update(addr, cell) {
    this._currentAddr = addr.toUpperCase();
    this._renderCellInfo(addr, cell);
    this._renderDeps(addr);
    this._renderDagInsight(addr, cell);
    this._renderStats();
    this._renderHistory();
  }

  _renderCellInfo(addr, cell) {
    document.getElementById('sbAddr').textContent  = addr;
    document.getElementById('sbRaw').textContent   = cell.raw  || '—';
    document.getElementById('sbValue').textContent = this._formatValue(cell.value);

    // Type badge
    const type = !cell.raw      ? 'empty'
      : cell.error               ? 'error'
      : cell.formula             ? 'formula'
      : typeof cell.value === 'number' ? 'number'
      : 'text';

    const badgeEl = document.getElementById('sbType');
    badgeEl.innerHTML = `<span class="type-badge type-${type}">${type}</span>`;

    // Dependency depth (how many levels of formulas above this cell)
    const depth = this._computeDepth(addr);
    document.getElementById('sbDepth').textContent = depth;
  }

  _renderDeps(addr) {
    const deps    = this.store.dag.getDirectDeps(addr);
    const usedBy  = this.store.dag.getDirectDependents(addr);

    // Reads From
    const depsOnEl    = document.getElementById('sbDepsOn');
    const depsOnCount = document.getElementById('sbDepsOnCount');
    depsOnCount.textContent = deps.length;
    if (deps.length === 0) {
      depsOnEl.innerHTML = '<span class="dep-empty">none</span>';
    } else {
      depsOnEl.innerHTML = deps.map(d => `
        <button class="dep-chip dep-source-chip" data-addr="${d}">${d}</button>
      `).join('');
    }

    // Read By
    const depsOfEl    = document.getElementById('sbDepsOf');
    const depsOfCount = document.getElementById('sbDepsOfCount');
    depsOfCount.textContent = usedBy.length;
    if (usedBy.length === 0) {
      depsOfEl.innerHTML = '<span class="dep-empty">none</span>';
    } else {
      depsOfEl.innerHTML = usedBy.map(d => `
        <button class="dep-chip dep-consumer-chip" data-addr="${d}">${d}</button>
      `).join('');
    }
  }

  _renderDagInsight(addr, cell) {
    const insight  = document.getElementById('sbDagInsight');
    const topoEl   = document.getElementById('sbTopoChain');
    topoEl.innerHTML = '';

    if (!cell.formula) {
      insight.textContent = cell.raw
        ? 'This is a literal value — no dependency edges.'
        : 'Empty cell.';
      return;
    }

    const deps       = this.store.dag.getDirectDeps(addr);
    const allDown    = this.store.dag.getAllDependents(addr);
    const totalDeps  = deps.length;
    const cascade    = allDown.length;

    // Run a mini topoSort to show the evaluation order
    const { order, hasCycle, cycleCells } = this.store.dag.topoSort([addr, ...allDown]);

    let html = `<strong>${addr}</strong> reads ${totalDeps} cell${totalDeps !== 1 ? 's' : ''}.`;
    if (cascade > 0) {
      html += ` Changing it triggers <strong>${cascade}</strong> downstream recomputation${cascade !== 1 ? 's' : ''}.`;
    }
    if (hasCycle) {
      html += ` <span class="cycle-warning">⚠ Cycle detected in: ${cycleCells.join(', ')}</span>`;
    }
    insight.innerHTML = html;

    // Show topological order chain (first 8 cells)
    const preview = order.slice(0, 8);
    if (preview.length > 1) {
      topoEl.innerHTML = '<div class="topo-label">Eval order:</div>' +
        preview.map((a, i) => `
          <span class="topo-node ${a === addr ? 'topo-origin' : ''}" data-addr="${a}">${a}</span>
          ${i < preview.length - 1 ? '<span class="topo-arrow">→</span>' : ''}
        `).join('') +
        (order.length > 8 ? `<span class="topo-more">+${order.length - 8} more</span>` : '');
    }
  }

  _renderStats() {
    const stats = this.store.stats();
    const dagStats = stats.dag;

    document.getElementById('sbStatsGrid').innerHTML = `
      <div class="stat-item"><span class="stat-n">${stats.totalCells}</span><span class="stat-l">Cells</span></div>
      <div class="stat-item"><span class="stat-n">${stats.formulas}</span><span class="stat-l">Formulas</span></div>
      <div class="stat-item"><span class="stat-n">${dagStats.edgeCount}</span><span class="stat-l">DAG Edges</span></div>
      <div class="stat-item"><span class="stat-n">${stats.errors}</span><span class="stat-l">Errors</span></div>
    `;
  }

  _renderHistory() {
    const entries  = this.history.getHistory(8);
    const countEl  = document.getElementById('sbHistCount');
    const listEl   = document.getElementById('sbHistList');
    countEl.textContent = this.history.undoCount;

    if (entries.length === 0) {
      listEl.innerHTML = '<div class="hist-empty">No actions yet.</div>';
      return;
    }

    listEl.innerHTML = entries.map((e, i) => `
      <div class="hist-item ${i === 0 ? 'hist-latest' : ''}">
        <span class="hist-idx">${i === 0 ? '↩' : i + 1}</span>
        <span class="hist-desc">${this._escHtml(e.describe)}</span>
      </div>
    `).join('');
  }

  // ─── FUNCTION LIST ───────────────────────────────────────────────────────────

  _buildFnList() {
    const functions = [
      // Math
      { name: 'SUM',        sig: 'SUM(range)',                cat: 'Math',    desc: 'Sum all numbers in a range' },
      { name: 'AVERAGE',    sig: 'AVERAGE(range)',            cat: 'Math',    desc: 'Arithmetic mean of range' },
      { name: 'MIN',        sig: 'MIN(range)',                cat: 'Math',    desc: 'Smallest value in range' },
      { name: 'MAX',        sig: 'MAX(range)',                cat: 'Math',    desc: 'Largest value in range' },
      { name: 'COUNT',      sig: 'COUNT(range)',              cat: 'Math',    desc: 'Count numeric cells' },
      { name: 'COUNTA',     sig: 'COUNTA(range)',             cat: 'Math',    desc: 'Count non-empty cells' },
      { name: 'PRODUCT',    sig: 'PRODUCT(range)',            cat: 'Math',    desc: 'Multiply all values' },
      { name: 'SUMSQ',      sig: 'SUMSQ(range)',              cat: 'Math',    desc: 'Sum of squares' },
      { name: 'STDEV',      sig: 'STDEV(range)',              cat: 'Math',    desc: 'Sample standard deviation' },
      { name: 'MEDIAN',     sig: 'MEDIAN(range)',             cat: 'Math',    desc: 'Middle value' },
      { name: 'LARGE',      sig: 'LARGE(range, k)',           cat: 'Math',    desc: 'k-th largest value' },
      { name: 'SMALL',      sig: 'SMALL(range, k)',           cat: 'Math',    desc: 'k-th smallest value' },
      { name: 'RANK',       sig: 'RANK(val, range)',          cat: 'Math',    desc: 'Rank of a value in range' },
      // Rounding
      { name: 'ROUND',      sig: 'ROUND(n, digits)',          cat: 'Round',   desc: 'Round to N decimal places' },
      { name: 'ROUNDUP',    sig: 'ROUNDUP(n, digits)',        cat: 'Round',   desc: 'Always round up' },
      { name: 'ROUNDDOWN',  sig: 'ROUNDDOWN(n, digits)',      cat: 'Round',   desc: 'Always round down' },
      { name: 'FLOOR',      sig: 'FLOOR(n, sig)',             cat: 'Round',   desc: 'Round down to significance' },
      { name: 'CEILING',    sig: 'CEILING(n, sig)',           cat: 'Round',   desc: 'Round up to significance' },
      { name: 'INT',        sig: 'INT(n)',                    cat: 'Round',   desc: 'Truncate to integer' },
      { name: 'ABS',        sig: 'ABS(n)',                    cat: 'Round',   desc: 'Absolute value' },
      { name: 'MOD',        sig: 'MOD(n, divisor)',           cat: 'Round',   desc: 'Remainder of division' },
      { name: 'SIGN',       sig: 'SIGN(n)',                   cat: 'Round',   desc: '-1, 0, or 1' },
      // Power / Exp
      { name: 'SQRT',       sig: 'SQRT(n)',                   cat: 'Power',   desc: 'Square root' },
      { name: 'POWER',      sig: 'POWER(base, exp)',          cat: 'Power',   desc: 'Exponentiation' },
      { name: 'LOG',        sig: 'LOG(n, base)',              cat: 'Power',   desc: 'Logarithm (default base 10)' },
      { name: 'LN',         sig: 'LN(n)',                     cat: 'Power',   desc: 'Natural logarithm' },
      { name: 'EXP',        sig: 'EXP(n)',                    cat: 'Power',   desc: 'e^n' },
      { name: 'PI',         sig: 'PI()',                      cat: 'Power',   desc: '3.14159…' },
      { name: 'RAND',       sig: 'RAND()',                    cat: 'Power',   desc: 'Random 0–1' },
      { name: 'RANDBETWEEN',sig: 'RANDBETWEEN(lo, hi)',       cat: 'Power',   desc: 'Random integer in range' },
      // Trig
      { name: 'SIN',        sig: 'SIN(radians)',              cat: 'Trig',    desc: 'Sine' },
      { name: 'COS',        sig: 'COS(radians)',              cat: 'Trig',    desc: 'Cosine' },
      { name: 'TAN',        sig: 'TAN(radians)',              cat: 'Trig',    desc: 'Tangent' },
      { name: 'ATAN2',      sig: 'ATAN2(y, x)',               cat: 'Trig',    desc: 'Arctangent of y/x' },
      { name: 'DEGREES',    sig: 'DEGREES(rad)',              cat: 'Trig',    desc: 'Radians → degrees' },
      { name: 'RADIANS',    sig: 'RADIANS(deg)',              cat: 'Trig',    desc: 'Degrees → radians' },
      // Logical
      { name: 'IF',         sig: 'IF(cond, t, f)',            cat: 'Logic',   desc: 'Conditional value' },
      { name: 'AND',        sig: 'AND(a, b, …)',              cat: 'Logic',   desc: 'All conditions true?' },
      { name: 'OR',         sig: 'OR(a, b, …)',               cat: 'Logic',   desc: 'Any condition true?' },
      { name: 'NOT',        sig: 'NOT(val)',                  cat: 'Logic',   desc: 'Invert boolean' },
      { name: 'IFERROR',    sig: 'IFERROR(val, fallback)',    cat: 'Logic',   desc: 'Replace errors' },
      { name: 'ISBLANK',    sig: 'ISBLANK(cell)',             cat: 'Logic',   desc: 'Is cell empty?' },
      { name: 'ISNUMBER',   sig: 'ISNUMBER(val)',             cat: 'Logic',   desc: 'Is value numeric?' },
      { name: 'ISERROR',    sig: 'ISERROR(val)',              cat: 'Logic',   desc: 'Is value an error?' },
      // Text
      { name: 'CONCAT',     sig: 'CONCAT(a, b, …)',           cat: 'Text',    desc: 'Join strings' },
      { name: 'LEN',        sig: 'LEN(text)',                 cat: 'Text',    desc: 'Length of string' },
      { name: 'LEFT',       sig: 'LEFT(text, n)',             cat: 'Text',    desc: 'First N characters' },
      { name: 'RIGHT',      sig: 'RIGHT(text, n)',            cat: 'Text',    desc: 'Last N characters' },
      { name: 'MID',        sig: 'MID(text, start, n)',       cat: 'Text',    desc: 'Substring' },
      { name: 'UPPER',      sig: 'UPPER(text)',               cat: 'Text',    desc: 'Uppercase' },
      { name: 'LOWER',      sig: 'LOWER(text)',               cat: 'Text',    desc: 'Lowercase' },
      { name: 'TRIM',       sig: 'TRIM(text)',                cat: 'Text',    desc: 'Remove extra spaces' },
      { name: 'SUBSTITUTE', sig: 'SUBSTITUTE(t, find, rep)',  cat: 'Text',    desc: 'Replace substring' },
      { name: 'TEXT',       sig: 'TEXT(n, format)',           cat: 'Text',    desc: 'Format number as text' },
      { name: 'VALUE',      sig: 'VALUE(text)',               cat: 'Text',    desc: 'Parse text as number' },
      // Lookup
      { name: 'VLOOKUP',    sig: 'VLOOKUP(val, range, col)',  cat: 'Lookup',  desc: 'Vertical table lookup' },
      { name: 'MATCH',      sig: 'MATCH(val, range)',         cat: 'Lookup',  desc: 'Position of value in range' },
      { name: 'INDEX',      sig: 'INDEX(range, row, col)',    cat: 'Lookup',  desc: 'Value at position in range' },
      // Date
      { name: 'NOW',        sig: 'NOW()',                     cat: 'Date',    desc: 'Current date and time' },
      { name: 'TODAY',      sig: 'TODAY()',                   cat: 'Date',    desc: 'Current date' },
      { name: 'YEAR',       sig: 'YEAR()',                    cat: 'Date',    desc: 'Current year' },
      { name: 'MONTH',      sig: 'MONTH()',                   cat: 'Date',    desc: 'Current month number' },
    ];

    this._allFunctions = functions;
    this._renderFnList(functions);
  }

  _renderFnList(fns) {
    const el = document.getElementById('fnList');
    if (!el) return;

    let currentCat = '';
    let html = '';
    for (const fn of fns) {
      if (fn.cat !== currentCat) {
        if (currentCat) html += '</div>';
        html += `<div class="fn-category"><div class="fn-cat-label">${fn.cat}</div>`;
        currentCat = fn.cat;
      }
      html += `
        <div class="fn-item" title="${this._escHtml(fn.desc)}">
          <span class="fn-name">${fn.name}</span>
          <span class="fn-sig">${this._escHtml(fn.sig)}</span>
        </div>
      `;
    }
    if (currentCat) html += '</div>';
    el.innerHTML = html;
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  /**
   * Compute the "formula depth" of a cell: the longest path of formula
   * dependencies leading to this cell. Literal values have depth 0.
   */
  _computeDepth(addr) {
    const visited = new Map();
    const dfs = (a) => {
      if (visited.has(a)) return visited.get(a);
      const deps = this.store.dag.getDirectDeps(a);
      if (deps.length === 0) { visited.set(a, 0); return 0; }
      const d = 1 + Math.max(...deps.map(dfs));
      visited.set(a, d);
      return d;
    };
    try { return dfs(addr); }
    catch { return '∞ (cycle)'; }
  }

  _formatValue(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'number') return parseFloat(v.toFixed(8)).toString();
    return String(v);
  }

  _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── EVENTS ──────────────────────────────────────────────────────────────────

  _bindEvents() {
    // Dep chip clicks → navigate to that cell
    this.container.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-addr]');
      if (chip) this.onNavigate(chip.dataset.addr);
    });

    // Function search
    this.container.addEventListener('input', (e) => {
      if (e.target.id !== 'fnSearch') return;
      const q = e.target.value.trim().toLowerCase();
      const filtered = q
        ? this._allFunctions.filter(f =>
            f.name.toLowerCase().includes(q) ||
            f.desc.toLowerCase().includes(q) ||
            f.cat.toLowerCase().includes(q)
          )
        : this._allFunctions;
      this._renderFnList(filtered);
    });
  }
}
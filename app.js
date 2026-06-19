/**
 * app.js — Application Bootstrap
 * ================================
 * Instantiates all modules and wires them together.
 *
 * ARCHITECTURE OVERVIEW:
 * ──────────────────────
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │                        UI LAYER                          │
 *  │   Toolbar   ←→   Grid (Controller)   ←→   Sidebar       │
 *  │                       │     ↑                            │
 *  │                  Renderer  Selection                     │
 *  └───────────────────────┼──────────────────────────────────┘
 *                          │ commands / queries
 *  ┌───────────────────────┼──────────────────────────────────┐
 *  │                   CORE LAYER                             │
 *  │   HistoryStack  →  CellStore  ←  DependencyGraph        │
 *  └───────────────────────┼──────────────────────────────────┘
 *                          │ evaluate
 *  ┌───────────────────────┼──────────────────────────────────┐
 *  │                 FORMULA LAYER                            │
 *  │       Lexer  →  Parser  →  AST  →  Evaluator            │
 *  └──────────────────────────────────────────────────────────┘
 *
 * MODULE LOAD ORDER (matters — each module uses globals from earlier ones):
 *   1. utils/format.js        — pure utilities, no deps
 *   2. core/address.js        — parseAddress, makeAddress, expandRange
 *   3. core/dag.js            — DependencyGraph
 *   4. formula/lexer.js       — Lexer, Token, TokenType
 *   5. formula/parser.js      — Parser, parseFormula, extractRefsFromAST
 *   6. formula/evaluator.js   — Evaluator, evaluateFormula, extractRefs
 *   7. core/store.js          — CellStore (uses dag + evaluator)
 *   8. core/history.js        — HistoryStack, CellEditCommand, BulkEditCommand
 *   9. io/serializer.js       — Serializer
 *  10. ui/selection.js        — CellSelection
 *  11. ui/renderer.js         — GridRenderer
 *  12. ui/grid.js             — Grid controller
 *  13. ui/sidebar.js          — Sidebar
 *  14. ui/toolbar.js          — Toolbar
 *  15. charts/sparkline.js    — ChartRenderer, ChartPanel
 *  16. app.js                 — this file, wires everything
 */

'use strict';

(function () {

  // ─── INSTANTIATION ─────────────────────────────────────────────────────────

  const store   = new CellStore();
  const history = new HistoryStack(300);

  const grid = new Grid({
    gridContainer: document.getElementById('gridContainer'),
    formulaBar:    document.getElementById('formulaBar'),
    cellRefInput:  document.getElementById('cellRef'),
    store,
    history,
    rows: 60,
    cols: 20,
    onSelectionChange: (info, cell) => {
      sidebar.update(info.activeAddr, cell);
      chartPanel.onSelectionChange();
      _updateStatusBar(info, cell);
    },
  });

  const sidebar = new Sidebar(
    document.getElementById('sidebar'),
    store,
    history,
    (addr) => grid.goTo(addr)
  );

  const chartPanel = new ChartPanel(
    document.getElementById('chartPanel'),
    store,
    () => grid.selection
  );

  const toolbar = new Toolbar({
    store,
    history,
    grid,
    getSelection:  () => grid.selection,
    formulaBar:    document.getElementById('formulaBar'),
  });

  // ─── STATUS BAR ────────────────────────────────────────────────────────────

  function _updateStatusBar(selInfo, cell) {
    const bar    = document.getElementById('statusBar');
    if (!bar) return;

    const parts = [];

    // Cell address
    parts.push(selInfo.isRange ? selInfo.rangeAddr : selInfo.activeAddr);

    // Cell value
    if (cell.error) {
      parts.push(`Error: ${cell.error}`);
    } else if (typeof cell.value === 'number') {
      parts.push(`= ${Format.number(cell.value)}`);
    } else if (cell.value) {
      parts.push(`"${Format.truncate(String(cell.value), 24)}"`);
    }

    // Range aggregates (when multi-cell selected)
    if (selInfo.isRange && selInfo.count > 1) {
      const addrs = grid.selection.selectedAddrs;
      const nums  = addrs
        .map(a => parseFloat(store.getValue(a)))
        .filter(n => !isNaN(n));

      if (nums.length > 0) {
        const sum = nums.reduce((a, b) => a + b, 0);
        const avg = sum / nums.length;
        parts.push(
          `Count: ${addrs.length}`,
          `Σ = ${Format.number(sum)}`,
          `Avg = ${Format.number(avg)}`
        );
      } else {
        parts.push(`Count: ${addrs.length}`);
      }
    }

    // History state
    parts.push(`↩ ${history.undoCount}`);

    // DAG stats
    const dagStats = store.dag.stats();
    parts.push(`Edges: ${dagStats.edgeCount}`);

    bar.textContent = parts.join('   |   ');
  }

  // ─── GLOBAL KEYBOARD SHORTCUTS ─────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs (except formula bar which handles its own)
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' && document.activeElement.id !== 'formulaBar') return;
    if (tag === 'TEXTAREA') return;

    const chord = Keys.chord(e);

    switch (chord) {
      case 'ctrl+z':
        e.preventDefault();
        history.undo();
        grid.renderer.renderAll();
        break;
      case 'ctrl+shift+z':
      case 'ctrl+y':
        e.preventDefault();
        history.redo();
        grid.renderer.renderAll();
        break;
      case 'ctrl+home':
        e.preventDefault();
        grid.goTo('A1');
        break;
      case 'ctrl+s':
        // Save JSON to downloads
        e.preventDefault();
        toolbar._download(
          Serializer.toJSON(store, { name: 'SheetEngine Workbook' }),
          'sheetengine.json',
          'application/json'
        );
        break;
    }
  });

  // ─── STORE CHANGE → STATUS BAR SYNC ───────────────────────────────────────

  store.on('change', () => {
    // Update status bar after store changes
    const addr = grid.selection.activeAddr;
    const cell = store.get(addr);
    _updateStatusBar({
      activeAddr: addr,
      rangeAddr:  grid.selection.rangeAddr,
      isRange:    grid.selection.isRange,
      count:      grid.selection.count,
    }, cell);

    // Keep sidebar stats fresh
    sidebar._renderStats();
    sidebar._renderHistory();
  });

  history.onChange(() => {
    sidebar._renderHistory();
  });

  // ─── SIDEBAR TOGGLE (mobile / narrow screens) ──────────────────────────────

  const toggleSb = document.getElementById('btnToggleSidebar');
  const sidebarEl = document.getElementById('sidebar');
  if (toggleSb && sidebarEl) {
    toggleSb.addEventListener('click', () => {
      sidebarEl.classList.toggle('sidebar-hidden');
      toggleSb.textContent = sidebarEl.classList.contains('sidebar-hidden') ? '▶' : '◀';
    });
  }

  // ─── CHART PANEL TOGGLE ───────────────────────────────────────────────────

  const toggleChart = document.getElementById('btnToggleChart');
  const chartEl     = document.getElementById('chartPanel');
  if (toggleChart && chartEl) {
    toggleChart.addEventListener('click', () => {
      chartEl.classList.toggle('chart-hidden');
      toggleChart.classList.toggle('active');
    });
  }

  // ─── INITIAL STATE ─────────────────────────────────────────────────────────

  sidebar.update('A1', store.get('A1'));
  _updateStatusBar(
    { activeAddr: 'A1', rangeAddr: 'A1', isRange: false, count: 1 },
    store.get('A1')
  );

  // Expose on window for debugging / interview demos
  window._sheet = { store, history, grid, sidebar, Serializer, Format };

  console.log(
    '%cSheetEngine loaded.\n' +
    '%cwindow._sheet.store  — access the cell store\n' +
    'window._sheet.history — undo stack\n' +
    'window._sheet.grid    — grid controller\n' +
    'Try: _sheet.store.set("A1", "42"); _sheet.store.set("B1", "=A1*2");',
    'color:#3ddc97;font-weight:bold;font-size:14px',
    'color:#8fa3bf;font-size:11px'
  );

})();
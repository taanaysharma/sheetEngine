/**
 * charts/sparkline.js
 * ===================
 * Lightweight canvas-based chart renderer for spreadsheet data.
 *
 * RENDERS:
 *   - Bar chart     (column chart for categorical data)
 *   - Line chart    (time-series / trend)
 *   - Sparkline     (mini inline trend indicator)
 *
 * WHY CANVAS NOT SVG?
 *   Canvas is pixel-based and faster for frequent redraws
 *   (e.g., chart updates every time a cell changes).
 *   SVG is retained-mode and better for interactive, scalable graphics.
 *   For a spreadsheet chart that rerenders on data change,
 *   canvas gives better throughput.
 *
 * DESIGN:
 *   ChartRenderer is a pure rendering class — it takes data arrays
 *   and draws onto a provided <canvas> element. No DOM creation,
 *   no event handling. The ChartPanel (below) owns the DOM.
 */

'use strict';

// ─── CHART RENDERER ──────────────────────────────────────────────────────────

class ChartRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this._setupHiDPI();
  }

  /** Handle high-DPI (retina) displays */
  _setupHiDPI() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.W = rect.width;
    this.H = rect.height;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.W, this.H);
  }

  // ─── BAR CHART ─────────────────────────────────────────────────────────────

  /**
   * Draw a vertical bar chart.
   * @param {number[]} data
   * @param {string[]} labels
   * @param {object}   opts
   */
  drawBar(data, labels = [], opts = {}) {
    if (!data || data.length === 0) return this._drawEmpty('No data');
    const {
      color     = '#3ddc97',
      negColor  = '#ff5c5c',
      bgColor   = '#1d2535',
      textColor = '#8fa3bf',
      padding   = { top: 24, right: 16, bottom: 40, left: 48 },
    } = opts;

    const ctx = this.ctx;
    const W   = this.W, H = this.H;
    const pw  = W - padding.left - padding.right;
    const ph  = H - padding.top  - padding.bottom;

    // Clear
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    const min     = Math.min(0, ...data);
    const max     = Math.max(...data);
    const range   = max - min || 1;
    const zeroY   = padding.top + ph * (max / range); // y position of zero line

    const barW    = Math.max(2, pw / data.length * 0.7);
    const barGap  = pw / data.length;

    // Grid lines
    ctx.strokeStyle = '#2d3f5c';
    ctx.lineWidth   = 1;
    const gridCount = 4;
    for (let i = 0; i <= gridCount; i++) {
      const y = padding.top + (ph * i / gridCount);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + pw, y);
      ctx.stroke();

      // Y axis label
      const val = max - (range * i / gridCount);
      ctx.fillStyle   = textColor;
      ctx.font        = '10px JetBrains Mono, monospace';
      ctx.textAlign   = 'right';
      ctx.fillText(this._fmtNum(val), padding.left - 4, y + 4);
    }

    // Zero line (if negative values exist)
    if (min < 0) {
      ctx.strokeStyle = '#4d6480';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(padding.left, zeroY);
      ctx.lineTo(padding.left + pw, zeroY);
      ctx.stroke();
    }

    // Bars
    data.forEach((val, i) => {
      const x   = padding.left + barGap * i + (barGap - barW) / 2;
      const barH = Math.abs(val / range * ph);
      const y   = val >= 0 ? zeroY - barH : zeroY;
      const c   = val >= 0 ? color : negColor;

      // Bar fill
      ctx.fillStyle = c + '99'; // slight transparency
      ctx.fillRect(x, y, barW, barH);

      // Bar top border line
      ctx.fillStyle = c;
      ctx.fillRect(x, val >= 0 ? y : y + barH - 2, barW, 2);

      // X label
      if (labels[i]) {
        ctx.fillStyle   = textColor;
        ctx.font        = '9px JetBrains Mono, monospace';
        ctx.textAlign   = 'center';
        ctx.fillText(String(labels[i]).slice(0, 5), x + barW / 2, H - padding.bottom + 14);
      }

      // Value on top
      if (barW > 20) {
        ctx.fillStyle   = c;
        ctx.font        = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign   = 'center';
        ctx.fillText(this._fmtNum(val), x + barW / 2, y - 4);
      }
    });

    // Axes
    ctx.strokeStyle = '#3d5478';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + ph);
    ctx.lineTo(padding.left + pw, padding.top + ph);
    ctx.stroke();
  }

  // ─── LINE CHART ────────────────────────────────────────────────────────────

  /**
   * Draw a smooth line chart.
   * @param {number[]} data
   * @param {string[]} labels
   * @param {object}   opts
   */
  drawLine(data, labels = [], opts = {}) {
    if (!data || data.length === 0) return this._drawEmpty('No data');
    const {
      color     = '#4da6ff',
      areaColor = '#4da6ff22',
      bgColor   = '#1d2535',
      textColor = '#8fa3bf',
      padding   = { top: 24, right: 16, bottom: 40, left: 48 },
      tension   = 0.4,
    } = opts;

    const ctx = this.ctx;
    const W   = this.W, H = this.H;
    const pw  = W - padding.left - padding.right;
    const ph  = H - padding.top  - padding.bottom;

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    const xOf  = (i) => padding.left + (i / (data.length - 1)) * pw;
    const yOf  = (v) => padding.top  + (1 - (v - min) / range) * ph;

    // Grid
    ctx.strokeStyle = '#2d3f5c';
    ctx.lineWidth   = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padding.top + (ph * i / 4);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + pw, y);
      ctx.stroke();
      const val = max - (range * i / 4);
      ctx.fillStyle   = textColor;
      ctx.font        = '10px JetBrains Mono, monospace';
      ctx.textAlign   = 'right';
      ctx.fillText(this._fmtNum(val), padding.left - 4, y + 4);
    }

    // Area fill under the line (gradient)
    const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + ph);
    grad.addColorStop(0, color + '55');
    grad.addColorStop(1, color + '05');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < data.length; i++) {
      const x0 = xOf(i - 1), y0 = yOf(data[i - 1]);
      const x1 = xOf(i),     y1 = yOf(data[i]);
      const cpx = (x0 + x1) / 2;
      ctx.bezierCurveTo(cpx, y0, cpx, y1, x1, y1);
    }
    ctx.lineTo(xOf(data.length - 1), padding.top + ph);
    ctx.lineTo(xOf(0), padding.top + ph);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < data.length; i++) {
      const x0 = xOf(i - 1), y0 = yOf(data[i - 1]);
      const x1 = xOf(i),     y1 = yOf(data[i]);
      const cpx = (x0 + x1) / 2;
      ctx.bezierCurveTo(cpx, y0, cpx, y1, x1, y1);
    }
    ctx.stroke();

    // Data points and labels
    data.forEach((v, i) => {
      const x = xOf(i), y = yOf(v);
      ctx.fillStyle   = color;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      if (labels[i]) {
        ctx.fillStyle   = textColor;
        ctx.font        = '9px JetBrains Mono, monospace';
        ctx.textAlign   = 'center';
        ctx.fillText(String(labels[i]).slice(0, 5), x, H - padding.bottom + 14);
      }
    });

    // Axes
    ctx.strokeStyle = '#3d5478';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + ph);
    ctx.lineTo(padding.left + pw, padding.top + ph);
    ctx.stroke();
  }

  // ─── SPARKLINE ─────────────────────────────────────────────────────────────

  /**
   * Tiny inline sparkline (no axes, no labels).
   * @param {number[]} data
   * @param {object}   opts
   */
  drawSparkline(data, opts = {}) {
    if (!data || data.length < 2) return;
    const {
      color  = '#3ddc97',
      bg     = 'transparent',
    } = opts;

    const ctx = this.ctx;
    const W   = this.W, H = this.H;
    const pad = 2;
    const min = Math.min(...data), max = Math.max(...data);
    const range = max - min || 1;

    ctx.clearRect(0, 0, W, H);
    if (bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }

    const xOf = (i) => pad + (i / (data.length - 1)) * (W - pad * 2);
    const yOf = (v) => H - pad - ((v - min) / range) * (H - pad * 2);

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(xOf(i), yOf(data[i]));
    }
    ctx.stroke();

    // Final dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xOf(data.length - 1), yOf(data[data.length - 1]), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  _drawEmpty(msg) {
    const ctx = this.ctx;
    ctx.fillStyle = '#1d2535';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.fillStyle   = '#4d6480';
    ctx.font        = '12px Inter, sans-serif';
    ctx.textAlign   = 'center';
    ctx.fillText(msg, this.W / 2, this.H / 2 + 4);
  }

  _fmtNum(n) {
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return parseFloat(n.toFixed(2)).toString();
  }
}

// ─── CHART PANEL ─────────────────────────────────────────────────────────────

/**
 * ChartPanel — owns the chart DOM panel (canvas + controls).
 * Reads selected range from the store and renders it.
 */
class ChartPanel {
  /**
   * @param {HTMLElement}  container
   * @param {CellStore}    store
   * @param {Function}     getSelection  () => CellSelection
   */
  constructor(container, store, getSelection) {
    this.container    = container;
    this.store        = store;
    this.getSelection = getSelection;
    this._type        = 'bar'; // 'bar' | 'line'

    this._buildDOM();
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="chart-header">
        <span class="chart-title">Chart</span>
        <div class="chart-type-btns">
          <button class="chart-type-btn active" data-type="bar">Bar</button>
          <button class="chart-type-btn" data-type="line">Line</button>
        </div>
        <button class="chart-render-btn" id="btnRenderChart">
          ▶ Chart Selection
        </button>
      </div>
      <div class="chart-canvas-wrap">
        <canvas id="chartCanvas"></canvas>
      </div>
      <div class="chart-status" id="chartStatus">Select a range, then click "Chart Selection"</div>
    `;

    this.canvas = this.container.querySelector('#chartCanvas');
    this._renderer = new ChartRenderer(this.canvas);

    // Type toggle buttons
    this.container.addEventListener('click', (e) => {
      const btn = e.target.closest('.chart-type-btn');
      if (btn) {
        this.container.querySelectorAll('.chart-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._type = btn.dataset.type;
        return;
      }
      if (e.target.id === 'btnRenderChart') {
        this._renderFromSelection();
      }
    });
  }

  _renderFromSelection() {
    const sel    = this.getSelection();
    const addrs  = sel.get2DAddrs();
    const status = document.getElementById('chartStatus');

    // Flatten: treat first row as labels if it contains text,
    // then use subsequent rows as data
    let labels = [];
    let data   = [];

    if (addrs.length === 1) {
      // Single row selection: each cell is a data point
      const row = addrs[0];
      data = row.map(a => {
        const v = parseFloat(this.store.getValue(a));
        return isNaN(v) ? 0 : v;
      });
      labels = row.map((_, i) => colLabel(i));
    } else if (addrs.length >= 2) {
      // Multi-row: check if first row is labels
      const firstRow = addrs[0].map(a => this.store.get(a).value);
      const firstIsText = firstRow.some(v => typeof v === 'string' && isNaN(parseFloat(v)));

      if (firstIsText) {
        labels = firstRow.map(String);
        // Sum remaining rows per column
        for (let c = 0; c < addrs[0].length; c++) {
          let sum = 0;
          for (let r = 1; r < addrs.length; r++) {
            const v = parseFloat(this.store.getValue(addrs[r][c]));
            if (!isNaN(v)) sum += v;
          }
          data.push(sum);
        }
      } else {
        // Use column index as labels
        labels = addrs[0].map((_, i) => colLabel(i));
        for (let c = 0; c < addrs[0].length; c++) {
          let sum = 0;
          for (let r = 0; r < addrs.length; r++) {
            const v = parseFloat(this.store.getValue(addrs[r][c]));
            if (!isNaN(v)) sum += v;
          }
          data.push(sum);
        }
      }
    }

    if (data.length === 0) {
      status.textContent = 'No numeric data in selection.';
      this._renderer.clear();
      this._renderer._drawEmpty('No numeric data');
      return;
    }

    // Re-setup HiDPI in case canvas was resized
    this._renderer._setupHiDPI();

    if (this._type === 'bar') {
      this._renderer.drawBar(data, labels);
    } else {
      this._renderer.drawLine(data, labels);
    }

    status.textContent = `${sel.rangeAddr} — ${data.length} values`;
  }

  /** Called when selection changes — auto-update if chart is visible */
  onSelectionChange() {
    // Auto-render if data already showing
    const status = document.getElementById('chartStatus');
    if (status && !status.textContent.includes('Select a range')) {
      this._renderFromSelection();
    }
  }
}
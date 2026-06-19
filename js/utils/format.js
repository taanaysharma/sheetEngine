/**
 * utils/format.js
 * ===============
 * Number and string formatting utilities used across the app.
 *
 * Keeping formatting logic here (not in the renderer or evaluator)
 * makes it reusable and independently testable.
 */

'use strict';

const Format = {

  // ─── NUMBER FORMATTING ───────────────────────────────────────────────────────

  /**
   * Format a number for display with locale-aware thousands separator.
   * Handles very large/small numbers with scientific notation.
   *
   * @param {number} n
   * @param {number} maxDecimals
   * @returns {string}
   */
  number(n, maxDecimals = 8) {
    if (!isFinite(n)) return n > 0 ? '∞' : '-∞';
    if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-7 && n !== 0)) {
      return n.toExponential(4);
    }
    return parseFloat(n.toFixed(maxDecimals)).toString();
  },

  /**
   * Format as currency (INR by default, matching D.E. Shaw India context).
   * @param {number} n
   * @param {string} symbol
   * @returns {string}
   */
  currency(n, symbol = '₹') {
    if (!isFinite(n)) return symbol + '—';
    return symbol + Math.abs(n).toLocaleString('en-IN', {
      minimumFractionDigits:  2,
      maximumFractionDigits:  2,
    });
  },

  /**
   * Format as percentage.
   * @param {number} n      Raw value (0.25 = 25%)
   * @param {number} digits Decimal places in output
   */
  percent(n, digits = 1) {
    return (n * 100).toFixed(digits) + '%';
  },

  /**
   * Abbreviate large numbers: 1200000 → "1.2M", 15000 → "15K"
   */
  abbrev(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
    return sign + abs.toString();
  },

  // ─── STRING UTILITIES ────────────────────────────────────────────────────────

  /**
   * Escape HTML special characters.
   */
  escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /**
   * Truncate a string to maxLen chars with ellipsis.
   */
  truncate(str, maxLen = 30) {
    const s = String(str);
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
  },

  /**
   * Pad a string to a given width (for column alignment in text export).
   */
  pad(str, width, align = 'left') {
    const s = String(str);
    if (s.length >= width) return s.slice(0, width);
    const padding = ' '.repeat(width - s.length);
    return align === 'right' ? padding + s : s + padding;
  },
};

// ─── KEYBOARD UTILITIES ──────────────────────────────────────────────────────

const Keys = {
  /**
   * Normalise a KeyboardEvent into a canonical key string.
   * e.g. Ctrl+Shift+Z → "ctrl+shift+z"
   */
  chord(e) {
    const parts = [];
    if (e.ctrlKey  || e.metaKey) parts.push('ctrl');
    if (e.altKey)                parts.push('alt');
    if (e.shiftKey)              parts.push('shift');
    parts.push(e.key.toLowerCase());
    return parts.join('+');
  },

  /** Is a key a printable character (not control, not F-key, etc.)? */
  isPrintable(e) {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  },

  /** Is the event a navigation arrow key? */
  isArrow(e) {
    return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
  },
};

// ─── DOM HELPERS ─────────────────────────────────────────────────────────────

const DOM = {
  /** Get an element by ID, throw if missing */
  get(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Element #${id} not found`);
    return el;
  },

  /** Try to get an element, return null if missing */
  tryGet(id) {
    return document.getElementById(id);
  },

  /** Toggle CSS class based on boolean */
  toggle(el, cls, on) {
    el.classList.toggle(cls, on);
  },

  /** Create an element with props and optional children */
  el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    children.forEach(c => {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    });
    return e;
  },

  /** Add a delegated event listener */
  delegate(parent, selector, event, handler) {
    parent.addEventListener(event, (e) => {
      const target = e.target.closest(selector);
      if (target) handler(e, target);
    });
  },
};
/* ═══ format.js ═══ */

/**
 * utils/format.js
 * ===============
 * Number and string formatting utilities used across the app.
 *
 * Keeping formatting logic here (not in the renderer or evaluator)
 * makes it reusable and independently testable.
 */


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


/* ═══ address.js ═══ */

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


/* ═══ dag.js ═══ */

/**
 * core/dag.js
 * ===========
 * Directed Acyclic Graph for cell dependency tracking.
 *
 * THE CORE CS PROBLEM:
 * --------------------
 * A spreadsheet is a DAG where nodes = cells, edges = "reads from".
 * When A1 changes, we must recompute all transitive dependents in
 * topological order — never evaluating a cell before its dependencies.
 *
 * Example:
 *   B1 = A1 + 1       →  edge B1 → A1
 *   C1 = B1 * 2       →  edge C1 → B1
 *   D1 = A1 + C1      →  edges D1 → A1, D1 → C1
 *
 *   When A1 changes: topoSort([B1, C1, D1]) → [B1, C1, D1]
 *   (D1 must come after C1 which must come after B1)
 *
 * CYCLE DETECTION:
 * ----------------
 * If A1 = B1 and B1 = A1, the DAG has a cycle.
 * Kahn's algorithm detects this: after processing, any node with
 * remaining in-degree > 0 was in a cycle. Those get #CYCLE! error.
 *
 * DATA STRUCTURES:
 * ----------------
 * Two adjacency maps for O(1) lookup in both directions:
 *   dependsOn[cell]  = Set<cell>  — cells THIS cell reads (outgoing edges)
 *   dependents[cell] = Set<cell>  — cells that READ this cell (incoming edges)
 *
 * Both maps are maintained in sync on every update.
 */


class DependencyGraph {
  constructor() {
    /**
     * Forward edges: cell → Set of cells it depends on
     * Example: if B1=A1+1, then dependsOn.get("B1") = Set{"A1"}
     * @type {Map<string, Set<string>>}
     */
    this.dependsOn  = new Map();

    /**
     * Reverse edges: cell → Set of cells that depend on it
     * Example: if B1=A1+1, then dependents.get("A1") = Set{"B1"}
     * @type {Map<string, Set<string>>}
     */
    this.dependents = new Map();

    /** Track edit version for cache invalidation */
    this._version = 0;
  }

  // ─── EDGE MANAGEMENT ────────────────────────────────────────────────────────

  /**
   * Update a cell's dependencies, maintaining both adjacency maps.
   *
   * Steps:
   *  1. Remove old reverse edges (cell was reading oldDeps, not anymore)
   *  2. Set new forward edges (cell now reads newDeps)
   *  3. Add new reverse edges (those cells now have cell as dependent)
   *
   * O(d) where d = max(|oldDeps|, |newDeps|)
   *
   * @param {string}   cell     Cell address e.g. "B1"
   * @param {string[]} newDeps  New dependencies e.g. ["A1", "C3"]
   */
  update(cell, newDeps) {
    cell = cell.toUpperCase();
    const deps = newDeps.map(d => d.toUpperCase());

    // Step 1: remove old reverse edges
    const oldDeps = this.dependsOn.get(cell);
    if (oldDeps) {
      for (const old of oldDeps) {
        const revSet = this.dependents.get(old);
        if (revSet) {
          revSet.delete(cell);
          if (revSet.size === 0) this.dependents.delete(old);
        }
      }
    }

    // Step 2: set new forward edges
    if (deps.length === 0) {
      this.dependsOn.delete(cell);
    } else {
      this.dependsOn.set(cell, new Set(deps));
    }

    // Step 3: add new reverse edges
    for (const dep of deps) {
      if (!this.dependents.has(dep)) this.dependents.set(dep, new Set());
      this.dependents.get(dep).add(cell);
    }

    this._version++;
  }

  /**
   * Remove all edges for a cell (when cell is cleared).
   * @param {string} cell
   */
  remove(cell) {
    this.update(cell.toUpperCase(), []);
    // Also remove as dependency if others pointed to it (keep those edges;
    // those cells will show empty/0 when this cell is absent)
    this.dependents.delete(cell.toUpperCase());
    this._version++;
  }

  // ─── TRAVERSAL ──────────────────────────────────────────────────────────────

  /**
   * Get all cells that transitively depend on `cell`.
   * Uses BFS on reverse edges. O(V + E) over the reachable subgraph.
   *
   * @param  {string}   cell
   * @returns {string[]} All transitive dependents (excludes `cell` itself)
   */
  getAllDependents(cell) {
    cell = cell.toUpperCase();
    const visited = new Set();
    const queue   = [cell];

    while (queue.length > 0) {
      const cur  = queue.shift();
      const deps = this.dependents.get(cur);
      if (!deps) continue;
      for (const d of deps) {
        if (!visited.has(d)) {
          visited.add(d);
          queue.push(d);
        }
      }
    }

    return [...visited]; // doesn't include `cell` itself
  }

  /**
   * Get direct dependencies of a cell.
   * @param  {string}   cell
   * @returns {string[]}
   */
  getDirectDeps(cell) {
    return [...(this.dependsOn.get(cell.toUpperCase()) || [])];
  }

  /**
   * Get direct dependents of a cell.
   * @param  {string}   cell
   * @returns {string[]}
   */
  getDirectDependents(cell) {
    return [...(this.dependents.get(cell.toUpperCase()) || [])];
  }

  // ─── TOPOLOGICAL SORT ───────────────────────────────────────────────────────

  /**
   * Kahn's Algorithm — BFS-based topological sort.
   *
   * WHY KAHN'S (not DFS-based topo sort)?
   *   Both are O(V+E), but Kahn's naturally produces cycle detection
   *   as a side effect: any node still having in-degree > 0 after the
   *   main loop is in a cycle. No separate DFS needed.
   *
   * ALGORITHM:
   *   1. Build in-degree map for the subgraph of `cells`
   *      (only count edges within the subgraph, not external deps)
   *   2. Enqueue all nodes with in-degree = 0 (no deps in subgraph)
   *   3. While queue non-empty:
   *      a. Dequeue node u, add to result
   *      b. For each v in dependents[u] ∩ subgraph:
   *         - reduce inDegree[v]
   *         - if inDegree[v] == 0, enqueue v
   *   4. Any node not in result has in-degree > 0 → was in a cycle
   *
   * @param  {string[]} cells  Subset of cells to sort
   * @returns {{ order: string[], hasCycle: boolean, cycleCells: string[] }}
   */
  topoSort(cells) {
    const cellSet = new Set(cells.map(c => c.toUpperCase()));

    // Step 1: compute in-degrees within subgraph only
    const inDegree = new Map();
    for (const c of cellSet) inDegree.set(c, 0);

    for (const c of cellSet) {
      const deps = this.dependsOn.get(c);
      if (!deps) continue;
      for (const dep of deps) {
        if (cellSet.has(dep)) {
          // dep is in subgraph and c depends on it → c has one more dependency
          inDegree.set(c, inDegree.get(c) + 1);
        }
      }
    }

    // Step 2: seed queue with zero-in-degree nodes
    const queue  = [];
    for (const [node, deg] of inDegree) {
      if (deg === 0) queue.push(node);
    }

    // Step 3: BFS topological ordering
    const order = [];
    while (queue.length > 0) {
      const u = queue.shift();
      order.push(u);

      // For each node v that depends on u (within subgraph):
      const deps = this.dependents.get(u);
      if (!deps) continue;
      for (const v of deps) {
        if (!cellSet.has(v)) continue;
        const newDeg = inDegree.get(v) - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) queue.push(v);
      }
    }

    // Step 4: cycle detection
    const cycleCells = [...cellSet].filter(c => !order.includes(c));

    return {
      order,                        // cells in safe evaluation order
      hasCycle: cycleCells.length > 0,
      cycleCells,                   // cells involved in cycles
    };
  }

  // ─── DIAGNOSTICS ────────────────────────────────────────────────────────────

  /**
   * Check if adding `cell → deps` would create a cycle.
   * Uses DFS from each dep to see if we can reach `cell`.
   *
   * @param  {string}   cell
   * @param  {string[]} deps
   * @returns {boolean}
   */
  wouldCreateCycle(cell, deps) {
    cell = cell.toUpperCase();
    const depSet = new Set(deps.map(d => d.toUpperCase()));

    // DFS from each dep — can we reach `cell`?
    const visited = new Set();
    const stack   = [...depSet];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === cell) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const further = this.dependsOn.get(cur);
      if (further) for (const f of further) stack.push(f);
    }
    return false;
  }

  /**
   * Return statistics about the graph (useful for the debugger panel).
   */
  stats() {
    let edgeCount = 0;
    for (const deps of this.dependsOn.values()) edgeCount += deps.size;
    return {
      nodeCount: this.dependsOn.size,
      edgeCount,
      version:   this._version,
    };
  }

  /**
   * Serialize the graph for export / debugging.
   */
  toJSON() {
    const obj = { dependsOn: {}, dependents: {} };
    for (const [k, v] of this.dependsOn)  obj.dependsOn[k]  = [...v];
    for (const [k, v] of this.dependents) obj.dependents[k] = [...v];
    return obj;
  }
}


/* ═══ lexer.js ═══ */

/**
 * formula/lexer.js
 * ================
 * Tokenizer (lexer) for spreadsheet formula strings.
 *
 * A lexer's job: convert a raw string into a stream of typed tokens.
 * The parser (parser.js) then works on tokens, not raw characters.
 *
 * Splitting lexing from parsing is the standard compiler design pattern:
 *   Source string → [Lexer] → Token stream → [Parser] → AST → [Evaluator] → Value
 *
 * TOKEN TYPES:
 *   NUMBER   — numeric literal: 42, 3.14, .5
 *   STRING   — quoted string:   "hello"
 *   CELL     — cell ref:        A1, BC42
 *   RANGE    — range:           A1:C3
 *   IDENT    — function name or keyword: SUM, IF, TRUE, FALSE, PI
 *   OP       — operator:        + - * / ^ % & = < > <= >= <> !=
 *   LPAREN   — (
 *   RPAREN   — )
 *   COMMA    — ,
 *   COLON    — : (used in ranges within function args)
 *   EOF      — end of input
 */


const TokenType = Object.freeze({
  NUMBER:  'NUMBER',
  STRING:  'STRING',
  CELL:    'CELL',
  RANGE:   'RANGE',
  IDENT:   'IDENT',
  OP:      'OP',
  LPAREN:  'LPAREN',
  RPAREN:  'RPAREN',
  COMMA:   'COMMA',
  COLON:   'COLON',
  EOF:     'EOF',
});

class Token {
  constructor(type, value, pos) {
    this.type  = type;
    this.value = value;
    this.pos   = pos; // character position in source (for error messages)
  }
  toString() { return `Token(${this.type}, ${JSON.stringify(this.value)}, @${this.pos})`; }
}

class LexerError extends Error {
  constructor(msg, pos) {
    super(`Lexer error at position ${pos}: ${msg}`);
    this.pos = pos;
  }
}

class Lexer {
  /**
   * @param {string} source  The formula string (with or without leading '=')
   */
  constructor(source) {
    // Strip leading '=' if present
    this.src  = source.startsWith('=') ? source.slice(1) : source;
    this.pos  = 0;
    this.tokens = [];
    this._tokenize();
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────────

  /** Return all tokens (excluding EOF for convenience of callers) */
  getTokens() { return this.tokens.filter(t => t.type !== TokenType.EOF); }

  /** Return all tokens including EOF */
  getAllTokens() { return this.tokens; }

  // ─── INTERNALS ───────────────────────────────────────────────────────────────

  _tokenize() {
    while (this.pos < this.src.length) {
      this._skipWhitespace();
      if (this.pos >= this.src.length) break;

      const start = this.pos;
      const ch    = this.src[this.pos];

      if (this._isDigit(ch) || (ch === '.' && this._isDigit(this.src[this.pos + 1] || ''))) {
        this._readNumber(start);
      } else if (ch === '"') {
        this._readString(start);
      } else if (this._isLetter(ch)) {
        this._readIdentOrCell(start);
      } else if (ch === '(') {
        this.tokens.push(new Token(TokenType.LPAREN, '(', start));
        this.pos++;
      } else if (ch === ')') {
        this.tokens.push(new Token(TokenType.RPAREN, ')', start));
        this.pos++;
      } else if (ch === ',') {
        this.tokens.push(new Token(TokenType.COMMA, ',', start));
        this.pos++;
      } else if (ch === ':') {
        // Standalone colon — rare but handle for safety
        this.tokens.push(new Token(TokenType.COLON, ':', start));
        this.pos++;
      } else if (this._isOpStart(ch)) {
        this._readOp(start);
      } else {
        // Unknown char: skip silently (robustness over strict errors)
        this.pos++;
      }
    }
    this.tokens.push(new Token(TokenType.EOF, null, this.pos));
  }

  _skipWhitespace() {
    while (this.pos < this.src.length && ' \t\r\n'.includes(this.src[this.pos])) {
      this.pos++;
    }
  }

  _isDigit(ch)  { return ch >= '0' && ch <= '9'; }
  _isLetter(ch) { return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_'; }
  _isAlNum(ch)  { return this._isLetter(ch) || this._isDigit(ch); }
  _isOpStart(ch){ return '+-*/%^&=<>!'.includes(ch); }

  _readNumber(start) {
    let s = '';
    // Integer part
    while (this.pos < this.src.length && this._isDigit(this.src[this.pos])) {
      s += this.src[this.pos++];
    }
    // Decimal part
    if (this.pos < this.src.length && this.src[this.pos] === '.') {
      s += '.';
      this.pos++;
      while (this.pos < this.src.length && this._isDigit(this.src[this.pos])) {
        s += this.src[this.pos++];
      }
    }
    // Scientific notation: 1e5, 1.2e-3
    if (this.pos < this.src.length && (this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
      s += this.src[this.pos++];
      if (this.pos < this.src.length && (this.src[this.pos] === '+' || this.src[this.pos] === '-')) {
        s += this.src[this.pos++];
      }
      while (this.pos < this.src.length && this._isDigit(this.src[this.pos])) {
        s += this.src[this.pos++];
      }
    }
    this.tokens.push(new Token(TokenType.NUMBER, parseFloat(s), start));
  }

  _readString(start) {
    this.pos++; // skip opening "
    let s = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '"') {
        // Check for escaped quote ""
        if (this.src[this.pos + 1] === '"') { s += '"'; this.pos += 2; }
        else { this.pos++; break; }
      } else {
        s += ch; this.pos++;
      }
    }
    this.tokens.push(new Token(TokenType.STRING, s, start));
  }

  _readIdentOrCell(start) {
    let s = '';
    while (this.pos < this.src.length && this._isAlNum(this.src[this.pos])) {
      s += this.src[this.pos++];
    }

    const upper = s.toUpperCase();

    // Check if it's followed by a colon (range like A1:B3)
    if (this.pos < this.src.length && this.src[this.pos] === ':') {
      // Peek ahead: is next part also a cell address?
      const colonPos = this.pos;
      let j = this.pos + 1;
      let s2 = '';
      while (j < this.src.length && this._isAlNum(this.src[j])) {
        s2 += this.src[j++];
      }
      if (s2 && this._looksLikeCell(upper) && this._looksLikeCell(s2.toUpperCase())) {
        // It's a range token
        const range = upper + ':' + s2.toUpperCase();
        this.pos = j;
        this.tokens.push(new Token(TokenType.RANGE, range, start));
        return;
      }
    }

    // Classify: cell ref vs keyword vs function name
    if (this._looksLikeCell(upper)) {
      this.tokens.push(new Token(TokenType.CELL, upper, start));
    } else if (upper === 'TRUE') {
      this.tokens.push(new Token(TokenType.NUMBER, 1, start));
    } else if (upper === 'FALSE') {
      this.tokens.push(new Token(TokenType.NUMBER, 0, start));
    } else {
      // Function name or keyword
      this.tokens.push(new Token(TokenType.IDENT, upper, start));
    }
  }

  _readOp(start) {
    const ch   = this.src[this.pos];
    const next = this.src[this.pos + 1] || '';

    // Two-char operators
    const two = ch + next;
    if (['<=', '>=', '<>', '!=', '**'].includes(two)) {
      this.tokens.push(new Token(TokenType.OP, two, start));
      this.pos += 2;
      return;
    }

    // Single-char operators (% handled as postfix in parser)
    this.tokens.push(new Token(TokenType.OP, ch, start));
    this.pos++;
  }

  /** Heuristic: does `s` look like a cell address? e.g. "A1", "BC42" */
  _looksLikeCell(s) {
    return /^[A-Z]{1,3}\d{1,7}$/.test(s);
  }
}


/* ═══ parser.js ═══ */

/**
 * formula/parser.js
 * =================
 * Recursive Descent Parser — converts token stream to an AST.
 *
 * WHY A REAL PARSER INSTEAD OF eval()?
 * -------------------------------------
 * 1. Security: eval() executes arbitrary JS. A parser only allows
 *    spreadsheet expressions — no document.cookie, no fetch().
 * 2. Control: we can show meaningful error messages, highlight
 *    the failing token, and recover gracefully.
 * 3. Inspection: the AST lets us extract cell references, show
 *    the parse tree in the debugger, and support future features
 *    (named ranges, array formulas, etc.)
 * 4. Interview signal: building a parser is a genuine CS skill.
 *    eval()-based "parsers" are immediately disqualifying.
 *
 * GRAMMAR (EBNF):
 * ---------------
 * expr        := comparison
 * comparison  := addition (('=' | '<>' | '<' | '>' | '<=' | '>=') addition)*
 * addition    := multiplication (('+' | '-') multiplication)*
 * multiplication := unary (('*' | '/' | '%') unary)*
 * unary       := ('-' | '+') unary | power
 * power       := postfix ('^' unary)*        (right-associative)
 * postfix     := primary ('%')?
 * primary     := NUMBER | STRING | CELL | RANGE | function_call
 *              | '(' expr ')'
 * function_call := IDENT '(' arg_list ')'
 * arg_list    := (expr (',' expr)*)?
 *
 * AST NODE TYPES:
 * ---------------
 * { type: 'Literal',  value: number | string }
 * { type: 'CellRef',  addr: 'A1' }
 * { type: 'RangeRef', range: 'A1:C3', cells: ['A1', 'A2', ...] }
 * { type: 'BinaryOp', op: '+', left: node, right: node }
 * { type: 'UnaryOp',  op: '-', operand: node }
 * { type: 'Percent',  operand: node }
 * { type: 'FnCall',   name: 'SUM', args: [node, ...] }
 */


class ParseError extends Error {
  constructor(msg, token) {
    super(msg);
    this.token = token;
    this.name  = 'ParseError';
  }
}

class Parser {
  /**
   * @param {Token[]} tokens  From Lexer.getTokens() (excludes EOF)
   */
  constructor(tokens) {
    this.tokens = tokens;
    this.pos    = 0;
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────────

  /**
   * Parse the token stream and return the root AST node.
   * @returns {object} AST root node
   * @throws  {ParseError}
   */
  parse() {
    if (this.tokens.length === 0) return { type: 'Literal', value: '' };
    const node = this.parseExpr();
    return node;
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  peek()    { return this.tokens[this.pos] || { type: TokenType.EOF, value: null }; }
  consume() { return this.tokens[this.pos++]; }
  atEnd()   { return this.pos >= this.tokens.length; }

  expect(type, value = null) {
    const t = this.peek();
    if (t.type !== type || (value !== null && t.value !== value)) {
      throw new ParseError(
        `Expected ${type}${value ? `(${value})` : ''}, got ${t.type}(${t.value})`,
        t
      );
    }
    return this.consume();
  }

  match(type, value = null) {
    const t = this.peek();
    if (t.type === type && (value === null || t.value === value)) {
      return this.consume();
    }
    return null;
  }

  // ─── GRAMMAR RULES ───────────────────────────────────────────────────────────

  /** expr := comparison */
  parseExpr() { return this.parseComparison(); }

  /** comparison := addition (('=' | '<>' | '<' | '>' | '<=' | '>=') addition)* */
  parseComparison() {
    let left = this.parseAddition();
    const compOps = ['=', '<>', '<', '>', '<=', '>=', '!='];

    while (!this.atEnd()) {
      const t = this.peek();
      if (t.type !== TokenType.OP || !compOps.includes(t.value)) break;
      const op = this.consume().value;
      const right = this.parseAddition();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  /** addition := multiplication (('+' | '-') multiplication)* */
  parseAddition() {
    let left = this.parseMultiplication();
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.type !== TokenType.OP || (t.value !== '+' && t.value !== '-')) break;
      const op = this.consume().value;
      const right = this.parseMultiplication();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  /** multiplication := unary (('*' | '/' | 'MOD') unary)* */
  parseMultiplication() {
    let left = this.parseUnary();
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.type !== TokenType.OP || (t.value !== '*' && t.value !== '/')) break;
      const op = this.consume().value;
      const right = this.parseUnary();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  /** unary := ('-' | '+') unary | power */
  parseUnary() {
    const t = this.peek();
    if (t.type === TokenType.OP && (t.value === '-' || t.value === '+')) {
      const op = this.consume().value;
      const operand = this.parseUnary();
      if (op === '+') return operand; // +x === x
      return { type: 'UnaryOp', op: '-', operand };
    }
    return this.parsePower();
  }

  /**
   * power := postfix ('^' unary)*
   * Right-associative: 2^3^4 = 2^(3^4)
   * Achieved by calling parseUnary() (not parsePower()) for right operand.
   */
  parsePower() {
    let base = this.parsePostfix();
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.type !== TokenType.OP || (t.value !== '^' && t.value !== '**')) break;
      this.consume();
      const exp = this.parseUnary(); // right-associative
      base = { type: 'BinaryOp', op: '^', left: base, right: exp };
    }
    return base;
  }

  /** postfix := primary ('%')? */
  parsePostfix() {
    let node = this.parsePrimary();
    if (!this.atEnd() && this.peek().type === TokenType.OP && this.peek().value === '%') {
      this.consume();
      node = { type: 'Percent', operand: node };
    }
    return node;
  }

  /**
   * primary := NUMBER | STRING | CELL | RANGE
   *          | IDENT '(' arg_list ')'
   *          | '(' expr ')'
   */
  parsePrimary() {
    const t = this.peek();

    // Number literal
    if (t.type === TokenType.NUMBER) {
      this.consume();
      return { type: 'Literal', value: t.value };
    }

    // String literal
    if (t.type === TokenType.STRING) {
      this.consume();
      return { type: 'Literal', value: t.value };
    }

    // Cell reference: A1, BC42
    if (t.type === TokenType.CELL) {
      this.consume();
      return { type: 'CellRef', addr: t.value };
    }

    // Range reference: A1:C3
    if (t.type === TokenType.RANGE) {
      this.consume();
      return {
        type:  'RangeRef',
        range: t.value,
        cells: expandRange(t.value), // pre-expand for evaluator
      };
    }

    // Function call: IDENT '(' arg_list ')'
    if (t.type === TokenType.IDENT) {
      const name = this.consume().value;
      if (this.peek().type === TokenType.LPAREN) {
        this.consume(); // consume '('
        const args = this.parseArgList();
        if (this.peek().type === TokenType.RPAREN) this.consume(); // consume ')'
        return { type: 'FnCall', name, args };
      }
      // Bare identifier (unknown) — treat as 0
      return { type: 'Literal', value: 0 };
    }

    // Parenthesized expression
    if (t.type === TokenType.LPAREN) {
      this.consume(); // consume '('
      const inner = this.parseExpr();
      if (this.peek().type === TokenType.RPAREN) this.consume(); // consume ')'
      return inner;
    }

    // Fallback for unexpected tokens
    this.consume(); // skip it
    return { type: 'Literal', value: 0 };
  }

  /**
   * arg_list := (expr (',' expr)*)?
   * Returns array of AST nodes (one per argument).
   */
  parseArgList() {
    const args = [];
    // Empty arg list: "SUM()"
    if (this.peek().type === TokenType.RPAREN || this.atEnd()) return args;

    args.push(this.parseExpr());

    while (!this.atEnd() && this.peek().type === TokenType.COMMA) {
      this.consume(); // consume ','
      if (this.peek().type === TokenType.RPAREN) break; // trailing comma tolerance
      args.push(this.parseExpr());
    }

    return args;
  }
}

/**
 * Convenience: parse a formula string directly to an AST.
 * Returns { ast, error } — error is null on success.
 */
function parseFormula(formula) {
  try {
    const lexer  = new Lexer(formula);
    const tokens = lexer.getAllTokens();
    const parser = new Parser(tokens.filter(t => t.type !== TokenType.EOF));
    const ast    = parser.parse();
    return { ast, error: null };
  } catch (e) {
    return { ast: null, error: e };
  }
}

/**
 * Extract all cell references from an AST (for dependency tracking).
 * Returns flat array of addresses (ranges already expanded).
 */
function extractRefsFromAST(ast) {
  if (!ast) return [];
  const refs = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'CellRef':
        refs.add(node.addr);
        break;
      case 'RangeRef':
        node.cells.forEach(c => refs.add(c));
        break;
      case 'BinaryOp':
        walk(node.left);
        walk(node.right);
        break;
      case 'UnaryOp':
      case 'Percent':
        walk(node.operand);
        break;
      case 'FnCall':
        node.args.forEach(walk);
        break;
    }
  }

  walk(ast);
  return [...refs];
}


/* ═══ evaluator.js ═══ */

/**
 * formula/evaluator.js
 * ====================
 * Tree-walking evaluator: takes an AST node and recursively computes its value.
 *
 * This is the "back-end" of the compiler pipeline:
 *   Source → Lexer → Tokens → Parser → AST → Evaluator → Value
 *
 * Design principles:
 *   - Pure function: eval(node, context) → value, no side effects
 *   - Context object provides cell lookup (late binding — values read at eval time)
 *   - All runtime errors produce spreadsheet-style error strings (#DIV/0!, etc.)
 *   - Numbers, strings, and booleans all flow naturally through the tree
 *
 * ERROR VALUE CONVENTION (matches Excel):
 *   #DIV/0!   — division by zero
 *   #VALUE!   — wrong type for operation
 *   #NAME?    — unknown function
 *   #REF!     — invalid cell reference
 *   #CYCLE!   — circular dependency (set by DependencyGraph, not here)
 *   #N/A      — function got no matching value
 *   #ERROR!   — catch-all parse/eval error
 */


// ─── RUNTIME ERRORS ──────────────────────────────────────────────────────────

const EvalErrors = Object.freeze({
  DIV0:   '#DIV/0!',
  VALUE:  '#VALUE!',
  NAME:   '#NAME?',
  REF:    '#REF!',
  CYCLE:  '#CYCLE!',
  NA:     '#N/A',
  ERROR:  '#ERROR!',
});

function isError(v) {
  return typeof v === 'string' && v.startsWith('#');
}

// ─── EVALUATOR ───────────────────────────────────────────────────────────────

class Evaluator {
  /**
   * @param {function(addr: string): any} getCellValue
   *   Function to look up the computed value of another cell.
   *   Returns the cell's value or '' for empty cells.
   */
  constructor(getCellValue) {
    this.getCellValue = getCellValue;
  }

  /**
   * Evaluate an AST node and return the computed value.
   *
   * @param  {object} node  AST node from Parser
   * @returns {number|string|boolean}
   */
  eval(node) {
    if (!node) return '';

    switch (node.type) {

      case 'Literal':
        return node.value;

      case 'CellRef': {
        const v = this.getCellValue(node.addr);
        return v === null || v === undefined ? 0 : v;
      }

      case 'RangeRef':
        // A range used outside a function context — return the value of
        // the top-left cell (matches Excel behavior)
        if (node.cells.length > 0) {
          const v = this.getCellValue(node.cells[0]);
          return v === null || v === undefined ? 0 : v;
        }
        return EvalErrors.REF;

      case 'UnaryOp': {
        const val = this.eval(node.operand);
        if (isError(val)) return val;
        const n = this._toNum(val);
        if (isError(n)) return n;
        return node.op === '-' ? -n : n;
      }

      case 'Percent': {
        const val = this.eval(node.operand);
        if (isError(val)) return val;
        const n = this._toNum(val);
        if (isError(n)) return n;
        return n / 100;
      }

      case 'BinaryOp':
        return this._evalBinaryOp(node.op, node.left, node.right);

      case 'FnCall':
        return this._evalFunction(node.name, node.args);

      default:
        return EvalErrors.ERROR;
    }
  }

  // ─── BINARY OPERATIONS ───────────────────────────────────────────────────────

  _evalBinaryOp(op, leftNode, rightNode) {
    // Comparison operators need string support too
    const isCompOp = ['=','<>','<','>','<=','>=','!='].includes(op);

    const left  = this.eval(leftNode);
    const right = this.eval(rightNode);

    if (isError(left))  return left;
    if (isError(right)) return right;

    if (isCompOp) {
      return this._compare(op, left, right) ? 1 : 0;
    }

    // Arithmetic operators need numbers
    if (op === '&') {
      // String concatenation (Excel's & operator)
      return String(left === null ? '' : left) + String(right === null ? '' : right);
    }

    const l = this._toNum(left);
    const r = this._toNum(right);
    if (isError(l)) return l;
    if (isError(r)) return r;

    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/':
        if (r === 0) return EvalErrors.DIV0;
        return l / r;
      case '^':
        return Math.pow(l, r);
      default:
        return EvalErrors.ERROR;
    }
  }

  _compare(op, left, right) {
    // Numeric comparison if both are numbers
    const ln = typeof left  === 'number' ? left  : parseFloat(left);
    const rn = typeof right === 'number' ? right : parseFloat(right);
    const bothNum = !isNaN(ln) && !isNaN(rn);

    const l = bothNum ? ln : String(left).toLowerCase();
    const r = bothNum ? rn : String(right).toLowerCase();

    switch (op) {
      case '=':   return l === r;
      case '<>':
      case '!=':  return l !== r;
      case '<':   return l < r;
      case '>':   return l > r;
      case '<=':  return l <= r;
      case '>=':  return l >= r;
      default:    return false;
    }
  }

  // ─── BUILT-IN FUNCTIONS ──────────────────────────────────────────────────────

  _evalFunction(name, argNodes) {
    // Lazy evaluation helper: evaluate arg node, return value
    const evalArg = (node) => this.eval(node);

    // Range resolver: expand RangeRef or CellRef args to arrays of values
    const resolveNumbers = (node) => {
      if (node.type === 'RangeRef') {
        return node.cells
          .map(a => this.getCellValue(a))
          .filter(v => v !== null && v !== '' && !isError(v))
          .map(v => parseFloat(v))
          .filter(n => !isNaN(n));
      }
      if (node.type === 'CellRef') {
        const v = parseFloat(this.getCellValue(node.addr));
        return isNaN(v) ? [] : [v];
      }
      const v = parseFloat(this.eval(node));
      return isNaN(v) ? [] : [v];
    };

    const resolveStrings = (node) => {
      if (node.type === 'RangeRef') {
        return node.cells
          .map(a => this.getCellValue(a))
          .filter(v => v !== null && v !== '' && !isError(v))
          .map(String);
      }
      if (node.type === 'CellRef') {
        const v = this.getCellValue(node.addr);
        return v !== null && v !== '' ? [String(v)] : [];
      }
      const v = this.eval(node);
      return v !== null && v !== '' ? [String(v)] : [];
    };

    const allNums = () => argNodes.flatMap(resolveNumbers);
    const allStrs = () => argNodes.flatMap(resolveStrings);

    switch (name) {

      // ── MATH / STATISTICS ──────────────────────────────────────────────────
      case 'SUM': {
        const nums = allNums();
        return nums.reduce((a, b) => a + b, 0);
      }
      case 'AVERAGE': case 'AVG': {
        const nums = allNums();
        if (nums.length === 0) return EvalErrors.DIV0;
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      }
      case 'MIN': {
        const nums = allNums();
        return nums.length === 0 ? 0 : Math.min(...nums);
      }
      case 'MAX': {
        const nums = allNums();
        return nums.length === 0 ? 0 : Math.max(...nums);
      }
      case 'COUNT': {
        return allNums().length;
      }
      case 'COUNTA': {
        return allStrs().length;
      }
      case 'PRODUCT': {
        const nums = allNums();
        return nums.reduce((a, b) => a * b, 1);
      }
      case 'SUMSQ': {
        const nums = allNums();
        return nums.reduce((a, b) => a + b * b, 0);
      }
      case 'STDEV': case 'STDEVP': {
        const nums = allNums();
        if (nums.length < 2) return 0;
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (name === 'STDEVP' ? nums.length : nums.length - 1);
        return Math.sqrt(variance);
      }
      case 'MEDIAN': {
        const nums = allNums().sort((a, b) => a - b);
        if (nums.length === 0) return 0;
        const mid = Math.floor(nums.length / 2);
        return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
      }
      case 'VAR': {
        const nums = allNums();
        if (nums.length < 2) return 0;
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        return nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1);
      }
      case 'LARGE': {
        const nums = allNums(); // first arg is range, second is k
        const k = argNodes[1] ? Math.round(parseFloat(this.eval(argNodes[1]))) : 1;
        const sorted = nums.sort((a, b) => b - a);
        return sorted[k - 1] ?? EvalErrors.NA;
      }
      case 'SMALL': {
        const nums = resolveNumbers(argNodes[0]);
        const k = argNodes[1] ? Math.round(parseFloat(this.eval(argNodes[1]))) : 1;
        const sorted = nums.sort((a, b) => a - b);
        return sorted[k - 1] ?? EvalErrors.NA;
      }
      case 'RANK': {
        const val  = parseFloat(this.eval(argNodes[0]));
        const nums = resolveNumbers(argNodes[1]);
        const desc = argNodes[2] ? !this.eval(argNodes[2]) : true;
        const sorted = [...nums].sort((a, b) => desc ? b - a : a - b);
        const rank = sorted.indexOf(val) + 1;
        return rank === 0 ? EvalErrors.NA : rank;
      }

      // ── ROUNDING ───────────────────────────────────────────────────────────
      case 'ROUND': {
        const [v, d] = argNodes.map(n => parseFloat(this.eval(n)));
        if (isNaN(v)) return EvalErrors.VALUE;
        return parseFloat(v.toFixed(isNaN(d) ? 0 : Math.max(0, d)));
      }
      case 'ROUNDUP': {
        const [v, d] = argNodes.map(n => parseFloat(this.eval(n)));
        const factor = Math.pow(10, isNaN(d) ? 0 : d);
        return Math.ceil(v * factor) / factor;
      }
      case 'ROUNDDOWN': {
        const [v, d] = argNodes.map(n => parseFloat(this.eval(n)));
        const factor = Math.pow(10, isNaN(d) ? 0 : d);
        return Math.floor(v * factor) / factor;
      }
      case 'FLOOR': {
        const [v, sig] = argNodes.map(n => parseFloat(this.eval(n)));
        return Math.floor(v / (sig || 1)) * (sig || 1);
      }
      case 'CEILING': {
        const [v, sig] = argNodes.map(n => parseFloat(this.eval(n)));
        return Math.ceil(v / (sig || 1)) * (sig || 1);
      }
      case 'INT':   { return Math.floor(parseFloat(this.eval(argNodes[0]))); }
      case 'ABS':   { return Math.abs(parseFloat(this.eval(argNodes[0]))); }
      case 'SQRT':  {
        const v = parseFloat(this.eval(argNodes[0]));
        if (v < 0) return EvalErrors.VALUE;
        return Math.sqrt(v);
      }
      case 'POWER': case 'POW': {
        const base = parseFloat(this.eval(argNodes[0]));
        const exp  = parseFloat(this.eval(argNodes[1]));
        return Math.pow(base, exp);
      }
      case 'MOD': {
        const a = parseFloat(this.eval(argNodes[0]));
        const b = parseFloat(this.eval(argNodes[1]));
        if (b === 0) return EvalErrors.DIV0;
        return a - Math.floor(a / b) * b;
      }
      case 'SIGN':  { return Math.sign(parseFloat(this.eval(argNodes[0]))); }
      case 'LOG':   {
        const v = parseFloat(this.eval(argNodes[0]));
        const base = argNodes[1] ? parseFloat(this.eval(argNodes[1])) : 10;
        if (v <= 0) return EvalErrors.VALUE;
        return Math.log(v) / Math.log(base);
      }
      case 'LN':    { const v = parseFloat(this.eval(argNodes[0])); return v <= 0 ? EvalErrors.VALUE : Math.log(v); }
      case 'EXP':   { return Math.exp(parseFloat(this.eval(argNodes[0]))); }
      case 'PI':    { return Math.PI; }
      case 'E':     { return Math.E; }
      case 'RAND':  { return Math.random(); }
      case 'RANDBETWEEN': {
        const lo = Math.ceil(parseFloat(this.eval(argNodes[0])));
        const hi = Math.floor(parseFloat(this.eval(argNodes[1])));
        return Math.floor(Math.random() * (hi - lo + 1)) + lo;
      }

      // ── TRIG ──────────────────────────────────────────────────────────────
      case 'SIN':   { return Math.sin(parseFloat(this.eval(argNodes[0]))); }
      case 'COS':   { return Math.cos(parseFloat(this.eval(argNodes[0]))); }
      case 'TAN':   { return Math.tan(parseFloat(this.eval(argNodes[0]))); }
      case 'ASIN':  { return Math.asin(parseFloat(this.eval(argNodes[0]))); }
      case 'ACOS':  { return Math.acos(parseFloat(this.eval(argNodes[0]))); }
      case 'ATAN':  { return Math.atan(parseFloat(this.eval(argNodes[0]))); }
      case 'ATAN2': {
        const y = parseFloat(this.eval(argNodes[0]));
        const x = parseFloat(this.eval(argNodes[1]));
        return Math.atan2(y, x);
      }
      case 'DEGREES': { return parseFloat(this.eval(argNodes[0])) * (180 / Math.PI); }
      case 'RADIANS': { return parseFloat(this.eval(argNodes[0])) * (Math.PI / 180); }

      // ── LOGICAL ───────────────────────────────────────────────────────────
      case 'IF': {
        const cond = this.eval(argNodes[0]);
        const truth = Boolean(cond) && cond !== 0 && cond !== '' && cond !== '0';
        if (truth) return argNodes[1] ? this.eval(argNodes[1]) : 1;
        return argNodes[2] ? this.eval(argNodes[2]) : 0;
      }
      case 'AND': {
        for (const n of argNodes) {
          const v = this.eval(n);
          if (!v || v === 0 || v === '') return 0;
        }
        return 1;
      }
      case 'OR': {
        for (const n of argNodes) {
          const v = this.eval(n);
          if (v && v !== 0 && v !== '') return 1;
        }
        return 0;
      }
      case 'NOT': {
        const v = this.eval(argNodes[0]);
        return (!v || v === 0) ? 1 : 0;
      }
      case 'IFERROR': {
        const v = this.eval(argNodes[0]);
        if (isError(v)) return argNodes[1] ? this.eval(argNodes[1]) : '';
        return v;
      }
      case 'IFNA': {
        const v = this.eval(argNodes[0]);
        if (v === EvalErrors.NA) return argNodes[1] ? this.eval(argNodes[1]) : '';
        return v;
      }
      case 'ISBLANK': {
        if (argNodes[0].type === 'CellRef') {
          const v = this.getCellValue(argNodes[0].addr);
          return v === null || v === '' ? 1 : 0;
        }
        return 0;
      }
      case 'ISNUMBER': {
        const v = this.eval(argNodes[0]);
        return typeof v === 'number' && !isNaN(v) ? 1 : 0;
      }
      case 'ISTEXT': {
        const v = this.eval(argNodes[0]);
        return typeof v === 'string' && !isError(v) ? 1 : 0;
      }
      case 'ISERROR': {
        const v = this.eval(argNodes[0]);
        return isError(v) ? 1 : 0;
      }

      // ── STRING ────────────────────────────────────────────────────────────
      case 'CONCAT': case 'CONCATENATE': {
        return argNodes.map(n => {
          const v = this.eval(n);
          return v === null || v === undefined ? '' : String(v);
        }).join('');
      }
      case 'LEN': {
        const v = this.eval(argNodes[0]);
        return String(v === null ? '' : v).length;
      }
      case 'LEFT': {
        const s = String(this.eval(argNodes[0]) ?? '');
        const n = argNodes[1] ? Math.max(0, parseInt(this.eval(argNodes[1]))) : 1;
        return s.slice(0, n);
      }
      case 'RIGHT': {
        const s = String(this.eval(argNodes[0]) ?? '');
        const n = argNodes[1] ? Math.max(0, parseInt(this.eval(argNodes[1]))) : 1;
        return s.slice(-n);
      }
      case 'MID': {
        const s     = String(this.eval(argNodes[0]) ?? '');
        const start = Math.max(1, parseInt(this.eval(argNodes[1]))) - 1;
        const len   = Math.max(0, parseInt(this.eval(argNodes[2])));
        return s.slice(start, start + len);
      }
      case 'UPPER': { return String(this.eval(argNodes[0]) ?? '').toUpperCase(); }
      case 'LOWER': { return String(this.eval(argNodes[0]) ?? '').toLowerCase(); }
      case 'TRIM':  { return String(this.eval(argNodes[0]) ?? '').trim(); }
      case 'REPT':  {
        const s = String(this.eval(argNodes[0]) ?? '');
        const n = Math.max(0, parseInt(this.eval(argNodes[1])));
        return s.repeat(n);
      }
      case 'SUBSTITUTE': {
        const text    = String(this.eval(argNodes[0]) ?? '');
        const find    = String(this.eval(argNodes[1]) ?? '');
        const replace = String(this.eval(argNodes[2]) ?? '');
        return text.split(find).join(replace);
      }
      case 'FIND': {
        const findStr = String(this.eval(argNodes[0]) ?? '');
        const inStr   = String(this.eval(argNodes[1]) ?? '');
        const idx = inStr.indexOf(findStr);
        return idx < 0 ? EvalErrors.VALUE : idx + 1;
      }
      case 'TEXT': {
        const v  = parseFloat(this.eval(argNodes[0]));
        const fmt = String(this.eval(argNodes[1]) ?? '');
        if (isNaN(v)) return EvalErrors.VALUE;
        // Very basic TEXT: support "0.00", "0%", "#,##0"
        if (fmt.includes('%')) return (v * 100).toFixed(fmt.replace(/[^0]/g,'').length) + '%';
        const decimals = (fmt.split('.')[1] || '').replace(/[^0]/g,'').length;
        return v.toFixed(decimals);
      }
      case 'VALUE': {
        const v = parseFloat(String(this.eval(argNodes[0]) ?? '').replace(/,/g,''));
        return isNaN(v) ? EvalErrors.VALUE : v;
      }

      // ── DATE / TIME ───────────────────────────────────────────────────────
      case 'NOW':     { return new Date().toLocaleString(); }
      case 'TODAY':   { return new Date().toLocaleDateString(); }
      case 'YEAR':    { return new Date().getFullYear(); }
      case 'MONTH':   { return new Date().getMonth() + 1; }
      case 'DAY':     { return new Date().getDate(); }
      case 'HOUR':    { return new Date().getHours(); }
      case 'MINUTE':  { return new Date().getMinutes(); }

      // ── LOOKUP ────────────────────────────────────────────────────────────
      case 'VLOOKUP': {
        const lookupVal = this.eval(argNodes[0]);
        const tableRange = argNodes[1];
        const colIdx = parseInt(this.eval(argNodes[2]));
        const exactMatch = argNodes[3] ? !this.eval(argNodes[3]) : true;

        if (tableRange.type !== 'RangeRef') return EvalErrors.VALUE;
        const { from, to } = parseRange(tableRange.range);
        if (!from || !to) return EvalErrors.REF;

        const r1 = Math.min(from.row, to.row);
        const r2 = Math.max(from.row, to.row);
        const c1 = Math.min(from.col, to.col);

        for (let r = r1; r <= r2; r++) {
          const firstCell = makeAddress(c1, r);
          const cellVal = this.getCellValue(firstCell);
          const match = exactMatch
            ? String(cellVal).toLowerCase() === String(lookupVal).toLowerCase()
            : parseFloat(cellVal) <= parseFloat(lookupVal);
          if (match) {
            const resultAddr = makeAddress(c1 + colIdx - 1, r);
            return this.getCellValue(resultAddr) ?? EvalErrors.NA;
          }
        }
        return EvalErrors.NA;
      }

      case 'MATCH': {
        const lookupVal = this.eval(argNodes[0]);
        const lookupRange = argNodes[1];
        if (!lookupRange || lookupRange.type !== 'RangeRef') return EvalErrors.VALUE;

        for (let i = 0; i < lookupRange.cells.length; i++) {
          const v = this.getCellValue(lookupRange.cells[i]);
          if (String(v).toLowerCase() === String(lookupVal).toLowerCase()) return i + 1;
        }
        return EvalErrors.NA;
      }

      case 'INDEX': {
        const rangeNode = argNodes[0];
        if (!rangeNode || rangeNode.type !== 'RangeRef') return EvalErrors.REF;
        const rowNum = argNodes[1] ? parseInt(this.eval(argNodes[1])) : 1;
        const colNum = argNodes[2] ? parseInt(this.eval(argNodes[2])) : 1;
        const { from } = parseRange(rangeNode.range);
        if (!from) return EvalErrors.REF;
        const addr = makeAddress(from.col + colNum - 1, from.row + rowNum - 1);
        return this.getCellValue(addr) ?? EvalErrors.NA;
      }

      default:
        return `#NAME? (${name})`;
    }
  }

  // ─── TYPE COERCION ───────────────────────────────────────────────────────────

  /**
   * Coerce a value to number. Returns EvalErrors.VALUE for non-numeric strings.
   */
  _toNum(v) {
    if (typeof v === 'number') return isNaN(v) ? EvalErrors.VALUE : v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null || v === '' || v === undefined) return 0;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? EvalErrors.VALUE : n;
  }
}

/**
 * Top-level formula evaluation function.
 * This is what CellStore calls for each cell.
 *
 * @param {string}            raw          Raw cell content e.g. "=SUM(A1:A5)"
 * @param {function(string)}  getCellValue Cell value lookup
 * @returns {number|string}
 */
function evaluateFormula(raw, getCellValue) {
  if (!raw || raw.trim() === '') return '';

  const trimmed = raw.trim();

  // Not a formula — parse as literal value
  if (!trimmed.startsWith('=')) {
    const n = parseFloat(trimmed);
    return isNaN(n) ? trimmed : n;
  }

  try {
    const { ast, error } = parseFormula(trimmed);
    if (error || !ast) return EvalErrors.ERROR;

    const evaluator = new Evaluator(getCellValue);
    const result = evaluator.eval(ast);

    // Final validation
    if (result === null || result === undefined) return 0;
    if (typeof result === 'number') {
      if (!isFinite(result)) return EvalErrors.DIV0;
    }
    return result;
  } catch (e) {
    return EvalErrors.ERROR + ': ' + e.message;
  }
}

/**
 * Extract all cell references from a raw formula string.
 * Used by CellStore to build DAG edges.
 *
 * @param {string} raw
 * @returns {string[]} Flat list of cell addresses
 */
function extractRefs(raw) {
  if (!raw || !raw.startsWith('=')) return [];
  const { ast } = parseFormula(raw);
  return extractRefsFromAST(ast);
}


/* ═══ store.js ═══ */

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


/* ═══ history.js ═══ */

/**
 * core/history.js
 * ===============
 * Undo/Redo system using the Command design pattern.
 *
 * COMMAND PATTERN:
 * ----------------
 * Every user action is encapsulated as a Command object with:
 *   execute() — performs the action
 *   undo()    — reverses it
 *   describe  — human-readable label for the action
 *
 * This decouples the "what to do" from "when to do it", enabling:
 *   - Arbitrary undo depth
 *   - Redo after undo
 *   - Macro recording (execute a sequence of commands)
 *   - Command logging for debugging
 *
 * STACK ARCHITECTURE:
 * -------------------
 *   past:   [cmd0, cmd1, cmd2]    ← undo pops from here
 *   future: [cmd3, cmd4]          ← redo pops from here
 *
 *   On new edit:   push to past, clear future (branch)
 *   On undo:       past.pop() → cmd.undo() → future.push(cmd)
 *   On redo:       future.pop() → cmd.execute() → past.push(cmd)
 *
 * BATCHING:
 * ---------
 * beginBatch() / endBatch() groups multiple commands into one undoable unit.
 * Used for operations like "paste range" or "delete selection".
 */


// ─── BASE COMMAND ─────────────────────────────────────────────────────────────

class Command {
  constructor(describe = 'Command') {
    this.describe = describe;
  }
  execute() { throw new Error('execute() not implemented'); }
  undo()    { throw new Error('undo() not implemented'); }
}

// ─── CELL EDIT COMMAND ────────────────────────────────────────────────────────

/**
 * CellEditCommand — wraps a single cell value change.
 *
 * Captures both old and new values at construction time,
 * so undo always knows what to restore even if the cell
 * is edited again later.
 */
class CellEditCommand extends Command {
  /**
   * @param {CellStore} store
   * @param {string}    addr    Cell address
   * @param {string}    newRaw  New raw content
   * @param {string}    oldRaw  Previous raw content (for undo)
   */
  constructor(store, addr, newRaw, oldRaw) {
    super(`Edit ${addr}: "${oldRaw}" → "${newRaw}"`);
    this.store  = store;
    this.addr   = addr;
    this.newRaw = newRaw;
    this.oldRaw = oldRaw;
  }

  execute() { return this.store.set(this.addr, this.newRaw); }
  undo()    { return this.store.set(this.addr, this.oldRaw); }
}

// ─── BULK EDIT COMMAND ────────────────────────────────────────────────────────

/**
 * BulkEditCommand — wraps a multi-cell change (paste, fill, import).
 */
class BulkEditCommand extends Command {
  /**
   * @param {CellStore} store
   * @param {{ addr: string, newRaw: string, oldRaw: string }[]} changes
   * @param {string} description
   */
  constructor(store, changes, description = 'Bulk edit') {
    super(description);
    this.store   = store;
    this.changes = changes;
  }

  execute() {
    this.store.setBulk(this.changes.map(c => ({ addr: c.addr, raw: c.newRaw })));
  }

  undo() {
    this.store.setBulk(this.changes.map(c => ({ addr: c.addr, raw: c.oldRaw })));
  }
}

// ─── BATCH COMMAND ────────────────────────────────────────────────────────────

/**
 * BatchCommand — wraps a sequence of commands as one undo unit.
 */
class BatchCommand extends Command {
  constructor(commands, description = 'Batch') {
    super(description);
    this.commands = commands;
  }

  execute() { this.commands.forEach(c => c.execute()); }
  undo()    { [...this.commands].reverse().forEach(c => c.undo()); }
}

// ─── HISTORY STACK ────────────────────────────────────────────────────────────

class HistoryStack {
  /**
   * @param {number} maxSize  Maximum commands to retain in undo history
   */
  constructor(maxSize = 200) {
    /** @type {Command[]} */
    this.past    = [];
    /** @type {Command[]} */
    this.future  = [];
    this.maxSize = maxSize;

    // Batching state
    this._batching      = false;
    this._batchCommands = [];
    this._batchDesc     = '';

    // Change listeners
    this._listeners = [];
  }

  // ─── PUBLIC API ─────────────────────────────────────────────────────────────

  /**
   * Execute a command and push it to the undo stack.
   * If batching, accumulate instead.
   *
   * @param {Command} command
   */
  push(command) {
    if (this._batching) {
      command.execute();
      this._batchCommands.push(command);
      return;
    }

    command.execute();
    this.past.push(command);
    this.future = []; // clear redo on new action

    // Trim history to maxSize (evict oldest)
    if (this.past.length > this.maxSize) {
      this.past.shift();
    }

    this._notify();
  }

  /**
   * Undo the last action.
   */
  undo() {
    if (!this.canUndo) return;
    const cmd = this.past.pop();
    cmd.undo();
    this.future.push(cmd);
    this._notify();
    return cmd;
  }

  /**
   * Redo the last undone action.
   */
  redo() {
    if (!this.canRedo) return;
    const cmd = this.future.pop();
    cmd.execute();
    this.past.push(cmd);
    this._notify();
    return cmd;
  }

  // ─── BATCHING ───────────────────────────────────────────────────────────────

  /**
   * Begin accumulating commands into a single undoable unit.
   */
  beginBatch(description = 'Batch') {
    this._batching      = true;
    this._batchCommands = [];
    this._batchDesc     = description;
  }

  /**
   * End batch and push as a single command.
   */
  endBatch() {
    if (!this._batching) return;
    this._batching = false;

    if (this._batchCommands.length === 0) return;
    if (this._batchCommands.length === 1) {
      this.past.push(this._batchCommands[0]);
    } else {
      this.past.push(new BatchCommand(this._batchCommands, this._batchDesc));
    }

    this.future = [];
    this._batchCommands = [];
    this._notify();
  }

  /**
   * Cancel the current batch (undo all accumulated commands).
   */
  cancelBatch() {
    if (!this._batching) return;
    this._batching = false;
    // Undo in reverse
    [...this._batchCommands].reverse().forEach(c => c.undo());
    this._batchCommands = [];
  }

  // ─── QUERY ──────────────────────────────────────────────────────────────────

  get canUndo() { return this.past.length > 0; }
  get canRedo()  { return this.future.length > 0; }
  get undoCount() { return this.past.length; }
  get redoCount() { return this.future.length; }

  get lastCommand() { return this.past[this.past.length - 1] || null; }

  /**
   * Get a human-readable undo history (newest first).
   * @param {number} n  Max entries to return
   */
  getHistory(n = 10) {
    return this.past.slice(-n).reverse().map((c, i) => ({
      index:    i,
      describe: c.describe,
    }));
  }

  // ─── CHANGE LISTENERS ───────────────────────────────────────────────────────

  onChange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(f => f !== fn); };
  }

  _notify() {
    this._listeners.forEach(fn => fn({
      canUndo:    this.canUndo,
      canRedo:    this.canRedo,
      undoCount:  this.undoCount,
      redoCount:  this.redoCount,
      lastAction: this.lastCommand?.describe || '',
    }));
  }
}


/* ═══ serializer.js ═══ */

/**
 * io/serializer.js
 * ================
 * Serialization and deserialization utilities.
 *
 * FORMATS SUPPORTED:
 *   CSV  — portable, opens in Excel/Sheets, loses formulas (display values only)
 *   JSON — full fidelity, preserves raw formulas + formats, proprietary
 *
 * WHY TWO FORMATS?
 *   CSV is the universal interchange format — any tool can open it.
 *   JSON preserves the spreadsheet's full state: if B1 = A1+1, the JSON
 *   saves "=A1+1" not "42". This means reloading a JSON file gives you
 *   back live formulas, not just static numbers.
 *   This is the same distinction Excel makes between .csv and .xlsx.
 *
 * VERSIONING:
 *   The JSON format includes a schema version field so future format
 *   changes can be handled with migration code. Good engineering practice.
 */


const SCHEMA_VERSION = '1.0';

const Serializer = {

  // ─── JSON ────────────────────────────────────────────────────────────────────

  /**
   * Serialize the full spreadsheet state to a JSON string.
   * Preserves: raw formulas, cell formats, sheet metadata.
   *
   * @param {CellStore}  store
   * @param {object}     meta   Optional sheet metadata (name, etc.)
   * @returns {string}   JSON string
   */
  toJSON(store, meta = {}) {
    const payload = {
      _schema:  SCHEMA_VERSION,
      _saved:   new Date().toISOString(),
      _engine:  'SheetEngine',
      meta: {
        name:    meta.name    || 'Untitled',
        author:  meta.author  || '',
        ...meta,
      },
      cells: store.toJSON(),
    };
    return JSON.stringify(payload, null, 2);
  },

  /**
   * Deserialize a JSON string and load it into the store.
   *
   * @param {string}     json
   * @param {CellStore}  store
   * @returns {{ ok: boolean, error: string|null, meta: object }}
   */
  fromJSON(json, store) {
    let payload;
    try {
      payload = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: 'Invalid JSON: ' + e.message, meta: {} };
    }

    // Version check
    if (payload._schema && payload._schema !== SCHEMA_VERSION) {
      console.warn(`SheetEngine: loading schema ${payload._schema}, current is ${SCHEMA_VERSION}`);
    }

    const cells = payload.cells || payload; // fallback: bare cells object
    try {
      store.fromJSON(cells);
      return { ok: true, error: null, meta: payload.meta || {} };
    } catch (e) {
      return { ok: false, error: 'Load error: ' + e.message, meta: {} };
    }
  },

  // ─── CSV ─────────────────────────────────────────────────────────────────────

  /**
   * Export the grid as a CSV string (display values, not formulas).
   *
   * @param {CellStore}  store
   * @param {number}     rows
   * @param {number}     cols
   * @returns {string}
   */
  toCSV(store, rows, cols) {
    return store.toCSV(rows, cols);
  },

  /**
   * Import CSV text into the store.
   * All imported values are treated as literals (no formula detection).
   *
   * @param {string}    csv
   * @param {CellStore} store
   * @returns {{ ok: boolean, count: number, error: string|null }}
   */
  fromCSV(csv, store) {
    try {
      const addrs = store.fromCSV(csv);
      return { ok: true, count: addrs.length, error: null };
    } catch (e) {
      return { ok: false, count: 0, error: e.message };
    }
  },

  // ─── CLIPBOARD ───────────────────────────────────────────────────────────────

  /**
   * Export a 2D address grid as tab-separated text (for system clipboard).
   * This is what Excel/Sheets paste when you paste into another app.
   *
   * @param {string[][]} addrs2d   2D array from selection.get2DAddrs()
   * @param {CellStore}  store
   * @returns {string}
   */
  toTSV(addrs2d, store) {
    return addrs2d
      .map(row => row.map(a => store.getDisplayValue(a)).join('\t'))
      .join('\n');
  },

  /**
   * Parse tab-separated text (from system clipboard) into cell entries.
   *
   * @param {string} tsv
   * @param {string} originAddr  Top-left cell to paste into
   * @returns {{ addr: string, raw: string }[]}
   */
  fromTSV(tsv, originAddr) {
    const origin = parseAddress(originAddr);
    if (!origin) return [];

    const entries = [];
    const lines   = tsv.split('\n');
    lines.forEach((line, r) => {
      const fields = line.split('\t');
      fields.forEach((val, c) => {
        if (val.trim() !== '') {
          entries.push({
            addr: makeAddress(origin.col + c, origin.row + r),
            raw:  val.trim(),
          });
        }
      });
    });
    return entries;
  },
};


/* ═══ selection.js ═══ */

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


/* ═══ renderer.js ═══ */

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


/* ═══ grid.js ═══ */

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


/* ═══ sidebar.js ═══ */

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


/* ═══ toolbar.js ═══ */

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


/* ═══ sparkline.js ═══ */

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


/* ═══ app.js ═══ */

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



// ─── BOOT (wait for DOM) ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // ─── INSTANTIATION ─────────────────────────────────────────────────────────
  // IMPORTANT: sidebar and chartPanel must be declared BEFORE grid,
  // because grid's constructor fires onSelectionChange immediately,
  // which references sidebar and chartPanel. Using let so they can be
  // assigned after declaration but before grid constructor runs.

  const store   = new CellStore();
  const history = new HistoryStack(300);

  // Declare first — assigned below before grid constructor fires the callback
  let sidebar    = null;
  let chartPanel = null;

  const grid = new Grid({
    gridContainer: document.getElementById('gridContainer'),
    formulaBar:    document.getElementById('formulaBar'),
    cellRefInput:  document.getElementById('cellRef'),
    store,
    history,
    rows: 60,
    cols: 20,
    onSelectionChange: (info, cell) => {
      // Guard: sidebar/chartPanel may not be assigned yet during construction
      if (sidebar)    sidebar.update(info.activeAddr, cell);
      if (chartPanel) chartPanel.onSelectionChange();
      _updateStatusBar(info, cell);
    },
  });

  // Now assign — grid constructor has finished
  sidebar = new Sidebar(
    document.getElementById('sidebar'),
    store,
    history,
    (addr) => grid.goTo(addr)
  );

  chartPanel = new ChartPanel(
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
    if (sidebar) sidebar._renderStats();
    if (sidebar) sidebar._renderHistory();
  });

  history.onChange(() => {
    if (sidebar) sidebar._renderHistory();
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


}); // end DOMContentLoaded

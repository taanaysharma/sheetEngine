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

'use strict';

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
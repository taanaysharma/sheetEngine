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

'use strict';

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
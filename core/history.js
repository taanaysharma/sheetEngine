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

'use strict';

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
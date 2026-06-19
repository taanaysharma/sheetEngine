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

'use strict';

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
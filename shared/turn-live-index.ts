import type { TimelineItem } from './protocol';
import { isNobodysWords, parseSynthetic } from './synthetic';

export type RootShape = 'head' | 'command' | 'steer' | 'notification' | 'hidden' | 'step' | 'work' | 'notice' | 'card' | 'visible' | 'output' | 'text' | 'interrupt' | 'end';
export function rootShape(i: TimelineItem): RootShape | undefined {
  switch (i.type) {
    case 'user': {
      if (i.state === 'queued') return;
      if (i.until) return 'command';
      const role = parseSynthetic(i.text)?.role;
      if (!role) return i.steered ? 'steer' : 'head';
      if (role === 'command') return 'command';
      if (role === 'output') return 'output';
      if (role === 'summary') return 'notice';
      return role === 'notification' ? 'notification' : 'hidden';
    }
    case 'text':
      if (!i.text.trim() || isNobodysWords(i.text)) return;
      return 'text';
    case 'thinking': return 'work';
    case 'tool':
      if (i.check) return;
      if (i.kind === 'todo') return 'work';
      return ['plan', 'share', 'widget'].includes(i.kind) ? 'visible' : 'step';
    case 'notice':
      if (i.early || i.until || i.agentSwitch || i.variant === 'rewind') return 'end';
      if (i.variant === 'interrupted') return 'interrupt';
      return i.variant === 'error' ? 'card' : i.variant === 'command' ? 'output' : 'notice';
    case 'turn': return 'end';
  }
}

export type TurnState = 'closed' | 'quiet' | 'open' | 'cut';
export interface Boundary<Position = number> { state: TurnState; pos?: Position }

/** A new position marks the opener of the next turn or the boundary that closed one.
 * A take after Stop resumes the original opener and all its work. */
export function turnBoundary<T>(state: TurnState, kind: RootShape, pos: T): Boundary<T> {
  if (kind === 'head' || kind === 'command') return { state: 'open', pos };
  if (kind === 'end' || (state === 'cut' && kind === 'notice')) return { state: 'closed', pos };
  if (kind === 'interrupt') return state === 'closed' ? { state, pos } : { state: 'cut' };
  if (state === 'cut' && kind === 'steer') return { state: 'open' };
  if (kind === 'notification' && state !== 'open') return { state: 'quiet', pos };
  if (state === 'closed') {
    if (kind === 'hidden') return { state: 'quiet', pos };
    if (kind !== 'notice' && kind !== 'card' && kind !== 'output') return { state: 'open', pos };
  }
  if (state === 'quiet' && kind !== 'hidden' && kind !== 'steer') return { state: 'open' };
  return { state };
}

/** Ordered item positions with a cached fold. Branch on the highest differing bit of two
 * positions: a replacement or a suffix query touches at most 32 branches, including in a
 * single very long turn. A sparse set (e.g. the occurrences of one file) pays only for
 * the positions it contains. Positions are array offsets, hence unsigned 32-bit integers. */
type Node<T> = { first: number; last: number; value: T; left?: Node<T>; right?: Node<T> };

export class PositionIndex<T> {
  private root?: Node<T>;
  constructor(private join: (a: T, b: T) => T) {}

  get last() { return this.root?.last; }
  get all() { return this.root?.value; }

  /** The first occupied position at or after from, skipping any holes in the range. */
  firstFrom(from: number): number | undefined {
    let node = this.root;
    if (!node || node.last < from) return;
    while (node.first < from && node.left && node.right) {
      node = node.left.last >= from ? node.left : node.right;
    }
    return node.first;
  }

  set(pos: number, value?: T) {
    const leaf = value === undefined ? undefined : { first: pos, last: pos, value };
    const branch = (left: Node<T>, right: Node<T>): Node<T> =>
      ({ first: left.first, last: right.last, left, right, value: this.join(left.value, right.value) });
    const put = (node?: Node<T>): Node<T> | undefined => {
      if (!node) return leaf;
      const prefix = Math.clz32(node.first ^ node.last);
      if (Math.clz32(node.first ^ pos) < prefix) {
        if (!leaf) return node;
        return pos < node.first ? branch(leaf, node) : branch(node, leaf);
      }
      if (!node.left || !node.right) return leaf;
      const split = 2 ** (31 - prefix);
      if ((pos & split) === 0) {
        const left = put(node.left);
        return left ? branch(left, node.right) : node.right;
      }
      const right = put(node.right);
      return right ? branch(node.left, right) : node.left;
    };
    this.root = put(this.root);
  }

  range(from: number, to = Infinity): T | undefined {
    const read = (node?: Node<T>): T | undefined => {
      if (!node || node.last < from || node.first >= to) return;
      if (node.first >= from && node.last < to) return node.value;
      const left = read(node.left);
      const right = read(node.right);
      return left === undefined ? right : right === undefined ? left : this.join(left, right);
    };
    return read(this.root);
  }
}

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

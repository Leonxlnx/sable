// Materialize the shape-only sample. Every known string length is in UTF-16 units.
// Array entries past the sampler's first twelve cycle through those twelve shapes.
function rowFromShape(row, serial) {
  const tool = row.detail && (row.detail.command ? 'bash' : row.detail.oldText ? 'edit' :
    row.detail.content ? 'write' : row.detail.path ? 'read' : row.kind.s === 5 ? 'agent' : 'bash');
  const labels = {
    type: tool ? 'tool' : row.attachments ? 'user' : row.type.s === 8 ? 'thinking' : 'text',
    kind: tool, name: tool && tool[0].toUpperCase() + tool.slice(1),
    status: row.status?.s === 5 ? 'error' : 'done', state: 'sent',
    id: serial.toString(36).padStart(row.id.s, '0'),
  };
  function make(shape, key, depth) {
    if (shape === null || typeof shape !== 'object') return shape;
    if (typeof shape.n === 'string') {
      const [, form, digits] = /^(int|negint|float|exp)(\d+)$/.exec(shape.n);
      const n = Number(digits);
      if (form === 'int') return Number('1' + '0'.repeat(n - 1));
      if (form === 'negint') return -Number('1' + '0'.repeat(n - 2));
      // JSON.stringify chooses decimal or exponential notation by magnitude.
      for (const exp of [-1, -6, -7, -12, -100, 21, 100]) {
        for (let digits = 0; digits <= 16; digits++) {
          const mantissa = '1' + (digits ? '.' + '2345678912345678'.slice(0, digits) : '');
          const number = Number(mantissa + 'e' + exp);
          for (const v of [number, -number]) {
            const token = JSON.stringify(v);
            if (token.length === n && (form === 'exp' ? token.includes('e') : !token.includes('e') && token.includes('.'))) return v;
          }
        }
      }
      throw new Error('Unsupported number shape ' + shape.n);
    }
    if (typeof shape.s === 'number') {
      const { s, back, uni, non } = shape;
      const label = depth === 1 && labels[key];
      if (label && label.length === s && !back && !non) return label;
      if (shape.dataUrl) return 'data:image/png;base64,' + 'QUJD'.repeat(Math.ceil(s / 4)).slice(0, s - 22);
      const path = /path/i.test(key);
      const special = back + non;
      if (!special) return 'x'.repeat(s);
      // Spread specials through the text so scanner edges also meet escapes.
      const chunks = [];
      for (let i = 0; i < special; i++) {
        const plain = s - special;
        chunks.push('x'.repeat(Math.floor((i + 1) * plain / special) - Math.floor(i * plain / special)));
        chunks.push(i < uni ? '\x01' : i < back ? (path ? '\\' : ['\n', '"', '\\'][i % 3]) : '界');
      }
      return chunks.join('');
    }
    if (typeof shape.a === 'number') {
      return Array.from({ length: shape.a }, (_, i) => make(shape.of[i % shape.of.length], key, depth + 1));
    }
    return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, make(v, k, depth + 1)]));
  }
  return make(row, '', 0);
}
module.exports = { rowFromShape };

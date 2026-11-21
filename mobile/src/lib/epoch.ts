/**
 * The pairing's data generation: one number for everything this phone keeps for the desktop it is
 * paired with. It moves on before that is erased (Forget, or a pairing that replaces it with another
 * computer), so work begun before (a send that fails and would put its words back, a picture still
 * decoding, a file still being checked) sees that it no longer belongs and writes nothing back.
 */
let gen = 0;

/** The generation now: taken when async work begins. */
export const epoch = () => gen;

/** True while work begun at generation `e` still belongs to the pairing in use. */
export const still = (e: number) => e === gen;

/** Moves on (conn.ts, right before what was kept is erased). */
export const bumpEpoch = () => ++gen;

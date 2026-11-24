import { highlightRuns } from '@/lib/fuzzy';
import './palette.css';

/**
 * The matched characters worth marking: a match is marked only where each word of the query
 * landed as one unbroken run (`tokens` words, so at most that many runs); a subsequence spread
 * over a word ("Se…t…ings") is marked not at all, since scattered lit letters read as noise.
 */
export function quietMarks(indices: number[] | undefined, tokens = 1): number[] | undefined {
  if (!indices?.length) return undefined;
  let runs = 1;
  for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1] + 1) runs++;
  return runs <= Math.max(1, tokens) ? indices : undefined;
}

/** Text with fuzzy-matched characters lit. */
export function Highlight({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, indices).map((r, i) =>
        r.hit ? (
          <mark key={i} className="hl">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

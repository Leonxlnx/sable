import { memo } from 'react';

/**
 * The cove: the composer is one pane of glass whose bottom-right corner is carved by a concave arc,
 * and in that cove sits the send key, an object of its own (composer.css has the shape and its
 * numbers). The card itself stays a plain rectangle that everything measures; its paint is these
 * layers, all static:
 * - the shade under the pane: its contact line and one short soft shadow (tokens.css `--shadow-pane`),
 *   hugging the cove's curve too; nothing else falls into the cove, and focus adds nothing to it;
 * - the frost: the blur of what is behind the pane, a layer of its own cut to the outline by a
 *   mask (on the glass, cut by its clip-path, the blur filled the card's whole box: the stage's
 *   round sheet clips too, and Chromium then loses the path for the backdrop);
 * - the glass: the frosted fill, clipped to the pane's outline, with the focus ink inside it;
 * - the rim, its focus step and the pointer's light, each a ring in two parts: the straight edges
 *   and the three plain corners (a masked ring, on whole pixels like every other pane's), and the
 *   cove's own curve.
 * Nothing here ever re-renders: it has no props.
 */
export const CoveSkin = memo(function CoveSkin() {
  return (
    <>
      <span className="cmp-shade" aria-hidden>
        <i className="sh-body" />
        <span className="sh-q">
          <i className="sh-far" />
          <i className="sh-cove" />
          <i className="sh-horn" data-at="side" />
          <i className="sh-horn" data-at="base" />
        </span>
      </span>
      <span className="cmp-frost" aria-hidden />
      <span className="cmp-glass" aria-hidden>
        <i className="gl-glow" />
        <i className="gl-ink" />
      </span>
      <CoveRing className="cmp-rim" />
      <CoveRing className="cmp-rim-lift" />
      {/* The pointer's light (ui/spot.ts moves the disc in each part). */}
      <span className="spot-ring cove-ring" aria-hidden>
        <span className="spot-part cr-edge">
          <i />
        </span>
        <span className="spot-part cr-cove">
          <i />
        </span>
      </span>
    </>
  );
});

/** A hairline along the pane's outline, in the rim's two parts. */
export function CoveRing({ className, children }: { className: string; children?: React.ReactNode }) {
  return (
    <span className={`cove-ring ${className}`} aria-hidden>
      <i className="cr-edge" />
      <i className="cr-cove" />
      {children}
    </span>
  );
}

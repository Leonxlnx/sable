import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { reduced, REVEAL } from './motion';

/**
 * A box whose height follows its content on a spring: what arrives (models, limits, an error)
 * grows the box instead of pushing everything under it in one frame. The first height is taken
 * as it is (nothing animates in on mount). The box's own padding and border count (a padded box, as
 * a sheet's keys are, lost that much of its content at the bottom: the web build's shorter keys
 * showed "Later" cut in half).
 */
export function AutoHeight({ children, className, role, label }: { children: ReactNode; className?: string; role?: string; label?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | 'auto'>('auto');
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const edges = () => {
      const o = outer.current;
      if (!o) return 0;
      const cs = getComputedStyle(o);
      return (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    };
    const read = () => setH(el.offsetHeight + edges());
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div ref={outer} className={className} role={role} aria-label={label} style={{ overflow: 'hidden' }} initial={false} animate={{ height: h }} transition={reduced() ? { duration: 0 } : REVEAL}>
      <div ref={inner} className="auto-h">
        {children}
      </div>
    </motion.div>
  );
}

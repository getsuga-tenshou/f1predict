import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Sticky offset for a side panel that may be taller than the viewport: it sticks at `gap`
 * when it fits, otherwise it scrolls with the page until its bottom is in view, then sticks.
 * No nested scroll container.
 */
export function useStickyTop<T extends HTMLElement>(gap = 24): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [top, setTop] = useState(gap);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      setTop(Math.min(gap, window.innerHeight - h - gap));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [gap]);
  return [ref, top];
}

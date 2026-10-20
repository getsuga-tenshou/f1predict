import { XIcon } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { IconButton } from "./Button";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Right-side drawer on desktop (560px), full-screen sheet on mobile. Modal: focus is trapped
 * inside, Esc and the close button close it, and focus returns to where it came from.
 */
/** `labelId` is the id of the heading inside `title` that names the dialog. */
export function Drawer({ title, labelId, onClose, children }: { title: ReactNode; labelId: string; onClose: () => void; children: ReactNode }) {
  const reduce = useReducedMotion() ?? false;
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    returnTo.current = document.activeElement;
    panel.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        panel.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      const target = returnTo.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[var(--z-drawer)]">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-[color-mix(in_srgb,var(--page)_55%,transparent)]"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className="absolute inset-0 flex flex-col overflow-y-auto bg-surface shadow-float outline-none sm:inset-y-2 sm:right-2 sm:left-auto sm:w-[560px] sm:max-w-[calc(100vw-1rem)] sm:rounded-panel sm:border sm:border-hair"
        initial={reduce ? false : { x: 32, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 30 }}
      >
        <div className="sticky top-0 z-[var(--z-sticky)] flex items-start justify-between gap-4 border-b border-hair bg-surface px-5 py-4">
          <div className="min-w-0">
            {title}
          </div>
          <IconButton label="Close" icon={<XIcon size={18} aria-hidden />} onClick={onClose} />
        </div>
        <div className="flex-1 px-5 py-5">{children}</div>
      </motion.div>
    </div>
  );
}

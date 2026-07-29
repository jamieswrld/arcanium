"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Minimal shadcn-style modal dialog: focus-trapped-enough for our flows,
 * closes on Escape/backdrop, theme-aware. Used for transaction review.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4 animate-[fadeIn_120ms_ease]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-card border border-border rounded-t-2xl sm:rounded-2xl p-5 w-full sm:max-w-md shadow-2xl animate-[slideUp_180ms_ease]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold m-0">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>
        <div>{children}</div>
        {footer !== undefined ? <div className="mt-4">{footer}</div> : null}
      </div>
    </div>
  );
}

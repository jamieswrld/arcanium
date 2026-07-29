"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Minimal shadcn-style toast system: a context provider + hook, no external
 * deps. Toasts stack bottom-right, auto-dismiss, and are theme-aware via the
 * Tailwind token classes.
 */

type ToastTone = "info" | "success" | "error" | "pending";

interface Toast {
  readonly id: number;
  readonly title: string;
  readonly description?: string | undefined;
  readonly tone: ToastTone;
  readonly href?: string | undefined;
  readonly hrefLabel?: string | undefined;
}

interface ToastContextValue {
  readonly toast: (t: Omit<Toast, "id">) => number;
  readonly dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const toneStyles: Record<ToastTone, string> = {
  info: "border-border",
  success: "border-positive/40",
  error: "border-negative/40",
  pending: "border-warning/40",
};

const toneDot: Record<ToastTone, string> = {
  info: "bg-muted-foreground",
  success: "bg-positive",
  error: "bg-negative",
  pending: "bg-warning animate-pulse",
};

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { ...t, id }]);
      if (t.tone !== "pending") {
        setTimeout(() => dismiss(id), 6_000);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[min(360px,calc(100vw-2rem))]">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`bg-card border ${toneStyles[t.tone]} rounded-xl p-3.5 shadow-lg flex gap-3 items-start animate-[slideIn_150ms_ease]`}
          >
            <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${toneDot[t.tone]}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">{t.title}</div>
              {t.description !== undefined ? (
                <div className="text-xs text-muted-foreground mt-0.5 break-words">{t.description}</div>
              ) : null}
              {t.href !== undefined ? (
                <a href={t.href} target="_blank" rel="noreferrer" className="text-xs text-primary underline mt-1 inline-block">
                  {t.hrefLabel ?? "View"}
                </a>
              ) : null}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground text-sm leading-none shrink-0"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    // No-op fallback so components never crash outside the provider.
    return { toast: () => 0, dismiss: () => undefined };
  }
  return ctx;
}

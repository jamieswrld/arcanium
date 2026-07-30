"use client";

import { useState } from "react";

/** Small inline copy-to-clipboard button with a "Copied" confirmation. */
export function CopyButton({ text, label = "Copy" }: { readonly text: string; readonly label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="arch-max-chip"
      style={{ cursor: "pointer", marginLeft: "0.4rem", verticalAlign: "middle" }}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => undefined);
      }}
      aria-label={`Copy ${text}`}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

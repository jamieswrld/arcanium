"use client";

import { useEffect } from "react";
import { useConnect } from "wagmi";

/**
 * Wallet picker.
 *
 * Lists every wallet wagmi discovers over EIP-6963 with its own icon, so the
 * user chooses rather than getting whichever extension injected first.
 *
 * Written on the Arcanium design system rather than utility classes: this dialog
 * previously depended on Tailwind colour utilities that never generated, so it
 * rendered as unstyled markup. Owning its own styles keeps it on-palette and
 * removes that failure mode entirely.
 *
 * Real states throughout: idle, connecting (per wallet), failed with the reason,
 * and a genuine empty state when no wallet is installed.
 */
export function ConnectModal({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { connectors, connect, isPending, variables, error } = useConnect();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  // wagmi can surface both the injected shim and the EIP-6963 provider for the
  // same wallet; keep one entry each, preferring the one carrying an icon.
  const seen = new Map<string, (typeof connectors)[number]>();
  for (const c of connectors) {
    const key = c.name.toLowerCase();
    const existing = seen.get(key);
    if (existing === undefined || (c.icon !== undefined && existing.icon === undefined)) {
      seen.set(key, c);
    }
  }
  const wallets = [...seen.values()];

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <div>
            <h2 style={{ fontSize: "1rem" }}>Connect a wallet</h2>
            <p className="hint" style={{ marginTop: 2 }}>
              Arcanium never holds your keys or your funds.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="sheet-body">
          {wallets.length === 0 ? (
            <div className="empty" style={{ padding: "28px 8px" }}>
              <h3>No wallet detected</h3>
              <p className="arch-note" style={{ maxWidth: 300 }}>
                Install a browser wallet, then reload this page. Arcanium works with any
                EIP-6963 wallet.
              </p>
              <div className="row" style={{ justifyContent: "center", flexWrap: "wrap", marginTop: "var(--s2)" }}>
                <a className="btn btn-secondary" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                  MetaMask
                </a>
                <a className="btn btn-secondary" href="https://rabby.io/" target="_blank" rel="noreferrer">
                  Rabby
                </a>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {wallets.map((c) => {
                const connectingThis = isPending && variables?.connector === c;
                return (
                  <button
                    key={c.uid}
                    type="button"
                    className="wallet-option"
                    disabled={isPending}
                    onClick={() => connect({ connector: c }, { onSuccess: onClose })}
                  >
                    {c.icon !== undefined ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.icon} alt="" width={26} height={26} style={{ borderRadius: "var(--r-sm)", flexShrink: 0 }} />
                    ) : (
                      <span className="wallet-option-fallback" aria-hidden>
                        {c.name.slice(0, 1)}
                      </span>
                    )}
                    <span style={{ fontWeight: 600, minWidth: 0 }}>{c.name}</span>
                    <span style={{ marginLeft: "auto", flexShrink: 0 }}>
                      {connectingThis ? (
                        <span className="hint">Connecting…</span>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ color: "var(--text-muted)" }}>
                          <path d="m9 5 7 7-7 7" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {error !== null && error !== undefined ? (
            <p className="err" style={{ marginTop: "var(--s3)" }}>
              {/^user rejected|denied/i.test(error.message)
                ? "Connection rejected in your wallet."
                : error.message.split("\n")[0]}
            </p>
          ) : null}
        </div>

        <div className="sheet-foot">
          <p className="hint" style={{ margin: 0 }}>
            Connecting only shares your public address. Every transaction is approved by you,
            in your wallet.
          </p>
        </div>
      </div>
    </div>
  );
}

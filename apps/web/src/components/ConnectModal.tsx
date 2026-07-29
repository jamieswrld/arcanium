"use client";

import { useConnect } from "wagmi";
import { Dialog } from "@/components/ui/Dialog";

/**
 * Wallet picker. Lists every wallet wagmi discovers via EIP-6963 (MetaMask,
 * Rabby, Coinbase Wallet, Rainbow, …) with its own icon, so the user chooses
 * rather than getting whichever injected first. Falls back to a helpful
 * message when no browser wallet is detected.
 */
export function ConnectModal({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { connectors, connect, isPending, variables } = useConnect();

  // De-duplicate by name (wagmi can surface the injected shim + the EIP-6963
  // provider for the same wallet); prefer entries that carry an icon.
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
    <Dialog open={open} onClose={onClose} title="Connect a wallet">
      {wallets.length === 0 ? (
        <p className="arch-note">
          No browser wallet detected. Install MetaMask, Rabby, Coinbase Wallet,
          or Rainbow, then reload.
        </p>
      ) : (
        <div className="grid gap-2">
          {wallets.map((c) => {
            const connectingThis = isPending && variables?.connector === c;
            return (
              <button
                key={c.uid}
                disabled={isPending}
                onClick={() =>
                  connect(
                    { connector: c },
                    { onSuccess: onClose },
                  )
                }
                className="flex items-center gap-3 w-full text-left px-3 py-3 rounded-xl border border-border bg-card hover:border-primary hover:bg-muted transition-colors disabled:opacity-60 cursor-pointer"
              >
                {c.icon !== undefined ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.icon} alt="" width={28} height={28} className="rounded-md" />
                ) : (
                  <span className="w-7 h-7 rounded-md bg-muted grid place-items-center text-xs font-bold">
                    {c.name.slice(0, 1)}
                  </span>
                )}
                <span className="font-medium">{c.name}</span>
                {connectingThis ? (
                  <span className="ml-auto text-xs text-muted-foreground">connecting…</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <p className="arch-note mt-3">
        New to this? A wallet is a browser extension that holds your funds. We
        never see your keys — you approve each action yourself.
      </p>
    </Dialog>
  );
}

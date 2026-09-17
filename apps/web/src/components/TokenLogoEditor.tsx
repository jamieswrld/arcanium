"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useSignMessage } from "wagmi";
import { compressImage } from "@/lib/imageCompress";
import { logoMessage } from "@/lib/logoSignature";
import { useToast } from "@/components/ui/Toast";

/**
 * Lets a token's launcher put a logo on it after the fact.
 *
 * Normally the launch form writes the logo seconds after the launch and this
 * never appears. It exists because that did not happen for the first Uniswap
 * v4 launches: the form decoded only v3's `Launched` event, so it never
 * learned the new token's address and never saved anything. Those tokens are
 * trading with a letter where their picture should be, and without this there
 * is no way to fix that short of relaunching.
 *
 * It shows itself to one person — the wallet that sent the launch transaction
 * — and only while the token has no logo. Everyone else sees nothing at all,
 * rather than a control that would reject them.
 */
export function TokenLogoEditor({
  token,
  name,
  symbol,
}: {
  readonly token: string;
  readonly name: string;
  readonly symbol: string;
}) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const router = useRouter();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [launcher, setLauncher] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Asked once the visitor connects, never before: for the overwhelming
  // majority of readers this is somebody else's token and the answer would go
  // straight in the bin.
  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    void fetch(`/api/tokens/${token}`)
      .then((r) => r.json() as Promise<{ launcher?: string | null; metadataUri?: string | null }>)
      .then((d) => {
        if (cancelled) return;
        setLauncher(d.launcher ?? null);
        setExisting(d.metadataUri ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isConnected, token]);

  const isLauncher =
    address !== undefined && launcher !== null && address.toLowerCase() === launcher.toLowerCase();
  if (!isLauncher) return null;

  async function onPick(file: File): Promise<void> {
    setBusy(true);
    try {
      const image = await compressImage(file);

      // Keep whatever the token already has — a description, a website, the
      // links — and change only the picture. Rebuilding the metadata from the
      // two fields this component happens to know would quietly delete the
      // rest.
      let base: Record<string, unknown> = { name, symbol, description: "", website: "", twitter: "", telegram: "", discord: "" };
      if (existing !== null && existing.startsWith("data:application/json;base64,")) {
        try {
          const decoded: unknown = JSON.parse(atob(existing.slice("data:application/json;base64,".length)));
          if (typeof decoded === "object" && decoded !== null) base = decoded as Record<string, unknown>;
        } catch {
          // Unreadable metadata is replaced rather than merged into. Leaving
          // the token with no logo because its old record will not parse would
          // be the wrong way to fail.
        }
      }
      const metadataUri = `data:application/json;base64,${btoa(JSON.stringify({ ...base, image }))}`;

      const signature = await signMessageAsync({ message: logoMessage(token, metadataUri) });
      const res = await fetch(`/api/tokens/${token}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ metadataUri, signature }),
      });
      const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || out?.ok !== true) {
        toast({ tone: "error", title: "Could not set the logo", description: out?.error ?? `HTTP ${res.status}` });
        return;
      }
      toast({ tone: "success", title: "Logo set", description: "It shows everywhere this token appears." });
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "failed") : "failed";
      if (/rejected|denied/i.test(message)) {
        toast({ tone: "error", title: "Rejected in wallet" });
        return;
      }
      toast({ tone: "error", title: "Could not set the logo", description: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="eyebrow">Token logo</span>
        <span className="arch-note" style={{ fontSize: "0.72rem" }}>only you can see this</span>
      </div>
      <div className="panel-body">
        <p className="arch-note" style={{ margin: 0, lineHeight: 1.65 }}>
          This token launched without a picture. You sent its launch transaction, so you can set one
          — a signature, not a transaction, and no gas.
        </p>
        <input
          ref={fileRef}
          id={`logo-${token}`}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) void onPick(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: "var(--s3)" }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? "Setting…" : "Choose an image"}
        </button>
      </div>
    </section>
  );
}

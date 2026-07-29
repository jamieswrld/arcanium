"use client";

import { useState } from "react";
import { ConnectModal } from "@/components/ConnectModal";

/** Full-width primary "Connect wallet" button that opens the wallet picker. */
export function ConnectButton({ label = "Connect wallet" }: { readonly label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="arch-primary-button" onClick={() => setOpen(true)}>
        {label}
      </button>
      <ConnectModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

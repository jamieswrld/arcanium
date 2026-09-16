"use client";

import { useEffect, useRef, useState } from "react";
import { ChainLogo } from "@/components/ChainLogo";

/**
 * Chain selector for the bridge.
 *
 * Replaces a native <select>, which cannot render anything but text in its
 * options — the reason the list was a column of bare chain names. Everything a
 * native select gives for free has to be rebuilt by hand, so it is: Escape and
 * outside clicks close it, arrow keys and Home/End move through options, Enter
 * commits, and focus returns to the trigger afterwards.
 */

export interface ChainOption {
  readonly key: string;
  readonly name: string;
}

export function ChainPicker({
  value,
  options,
  disabled,
  label,
  onChange,
}: {
  readonly value: string;
  readonly options: readonly ChainOption[];
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.key === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.key === value)));
  }, [open, options, value]);

  function commit(key: string): void {
    onChange(key);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[active];
      if (opt !== undefined) commit(opt.key);
    }
  }

  return (
    <div ref={rootRef} className="chain-picker" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="chain-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {selected === undefined ? null : (
          <>
            <ChainLogo chainKey={selected.key} name={selected.name} size={16} />
            <span className="chain-picker-name">{selected.name}</span>
          </>
        )}
        <span aria-hidden className="chain-picker-caret">
          ▾
        </span>
      </button>

      {!open ? null : (
        <ul className="chain-picker-menu" role="listbox" aria-label={label} tabIndex={-1}>
          {options.map((o, i) => (
            <li key={o.key}>
              <button
                type="button"
                role="option"
                aria-selected={o.key === value}
                className={
                  i === active ? "chain-picker-option chain-picker-option-active" : "chain-picker-option"
                }
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(o.key)}
              >
                <ChainLogo chainKey={o.key} name={o.name} size={18} />
                <span>{o.name}</span>
                {o.key === value ? (
                  <span aria-hidden className="chain-picker-tick">
                    ✓
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

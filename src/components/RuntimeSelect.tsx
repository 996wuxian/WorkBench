/**
 * Custom runtime picker — replaces native <select> (OS menus can't be themed).
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "./icons";
import type { RuntimeId } from "../lib/types";
import { RUNTIME_LABEL } from "../lib/types";

export type RuntimeOption = {
  id: RuntimeId;
  label?: string;
  hint?: string;
};

type Props = {
  value: RuntimeId;
  options: RuntimeOption[];
  onChange: (id: RuntimeId) => void;
  disabled?: boolean;
  "aria-label"?: string;
  title?: string;
  className?: string;
};

export function RuntimeSelect({
  value,
  options,
  onChange,
  disabled,
  "aria-label": ariaLabel = "选择引擎",
  title,
  className = "",
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.id === value) ?? options[0];
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;

    const place = () => {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const menuH = Math.min(280, 12 + options.length * 44);
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const openUp = spaceBelow < menuH && r.top > spaceBelow;
      setPos({
        top: openUp ? r.top - menuH - 6 : r.bottom + 6,
        left: r.left,
        width: Math.max(r.width, 168),
      });
    };
    place();

    const onDoc = (e: MouseEvent) => {
      const n = e.target as Node;
      if (rootRef.current?.contains(n) || menuRef.current?.contains(n)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  const menu =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            className="rt-select__menu"
            role="listbox"
            id={listId}
            style={{
              top: pos.top,
              left: pos.left,
              minWidth: pos.width,
            }}
          >
            {options.map((o) => {
              const active = o.id === value;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={"rt-select__option" + (active ? " is-selected" : "")}
                  onClick={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                >
                  <span className={`runtime-dot runtime-dot--${o.id}`} />
                  <span className="rt-select__option-text">
                    <span className="rt-select__option-label">
                      {o.label ?? RUNTIME_LABEL[o.id]}
                    </span>
                    {o.hint ? (
                      <span className="rt-select__option-hint">{o.hint}</span>
                    ) : null}
                  </span>
                  {active ? (
                    <span className="rt-select__check" aria-hidden>
                      <IconCheck size={14} />
                    </span>
                  ) : (
                    <span className="rt-select__check" aria-hidden />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      ref={rootRef}
      className={`rt-select ${open ? "is-open" : ""} ${className}`.trim()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="rt-select__trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        title={title}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <span className={`runtime-dot runtime-dot--${selected?.id ?? value}`} />
        <span className="rt-select__value">
          {selected?.label ?? RUNTIME_LABEL[value]}
        </span>
        <span className={"rt-select__chev" + (open ? " is-open" : "")} aria-hidden>
          <IconChevronDown size={14} />
        </span>
      </button>
      {menu}
    </div>
  );
}

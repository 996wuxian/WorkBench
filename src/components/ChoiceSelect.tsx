import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown } from "./icons";

export type ChoiceOption = {
  value: string;
  label: string;
  hint?: string | null;
  suffix?: string | null;
  disabled?: boolean;
};

type Props = {
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  className?: string;
  placeholder?: string;
  placement?: "auto" | "top" | "bottom";
  renderIcon?: (option: ChoiceOption) => ReactNode;
  getOptionClassName?: (option: ChoiceOption) => string;
};

export function ChoiceSelect({
  value,
  options,
  onChange,
  disabled,
  title,
  "aria-label": ariaLabel = "选择选项",
  className = "",
  placeholder = "—",
  placement = "auto",
  renderIcon,
  getOptionClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;

    const place = () => {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const menuH = Math.min(320, 12 + options.length * 44);
      const gap = 12;
      const spaceBelow = window.innerHeight - r.bottom - gap;
      const openUp =
        placement === "top" || (placement === "auto" && spaceBelow < menuH && r.top > spaceBelow);
      const maxHeight = Math.max(
        120,
        Math.min(320, openUp ? r.top - gap - 8 : window.innerHeight - r.bottom - gap - 8),
      );
      setPos(
        openUp
          ? {
              bottom: window.innerHeight - r.top + gap,
              left: r.left,
              maxHeight,
            }
          : {
              top: r.bottom + gap,
              left: r.left,
              maxHeight,
            },
      );
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
  }, [open, options.length, placement]);

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
              bottom: pos.bottom,
              left: pos.left,
              maxHeight: pos.maxHeight,
            }}
          >
            {options.map((o) => {
              const active = o.value === value;
              const optionDisabled = Boolean(o.disabled);
              const icon = renderIcon?.(o);
              const optionClassName = getOptionClassName?.(o) ?? "";
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={optionDisabled}
                  className={[
                    "rt-select__option",
                    active ? "is-selected" : "",
                    optionClassName,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => {
                    if (optionDisabled) return;
                    onChange(o.value);
                    setOpen(false);
                  }}
                  >
                  {icon ? (
                    <span className="rt-select__option-icon" aria-hidden>
                      {icon}
                    </span>
                  ) : null}
                  <span className="rt-select__option-main">
                    <span className="rt-select__option-label">{o.label}</span>
                    {o.hint ? (
                      <span className="rt-select__option-hint">{o.hint}</span>
                    ) : null}
                  </span>
                  <span className="rt-select__option-side">
                    {active ? (
                      <span className="rt-select__check" aria-hidden>
                        <IconCheck size={14} />
                      </span>
                    ) : (
                      <span className="rt-select__check" aria-hidden />
                    )}
                  </span>
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
        <span
          className={[
            "rt-select__value",
            selected ? (getOptionClassName?.(selected) ?? "") : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {selected && renderIcon ? (
            <span className="rt-select__value-icon" aria-hidden>
              {renderIcon(selected)}
            </span>
          ) : null}
          <span className="rt-select__value-label">
            {selected?.label ?? placeholder}
          </span>
        </span>
        <span className={"rt-select__chev" + (open ? " is-open" : "")} aria-hidden>
          <IconChevronDown size={14} />
        </span>
      </button>
      {menu}
    </div>
  );
}

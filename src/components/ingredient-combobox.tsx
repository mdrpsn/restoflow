"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

type Ingredient = { id: string; name: string; unit: string };

const MAX_OPTIONS = 20;

/**
 * Type-to-filter ingredient picker: type a few letters, arrow up/down to
 * highlight, Enter or Tab to commit. Already-used ingredients (from other
 * lines in the same form) are passed via excludeIds and simply never appear,
 * so a duplicate can't be selected through this control.
 */
export function IngredientCombobox({
  ingredients,
  excludeIds,
  value,
  onCommit,
  inputRef,
  onCommitNext,
  autoFocus,
}: {
  ingredients: Ingredient[];
  excludeIds: string[];
  value: string;
  onCommit: (ingredientId: string) => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  /** Called right after a selection is committed via keyboard/click, so the caller can move focus to the next field. */
  onCommitNext?: () => void;
  autoFocus?: boolean;
}) {
  const selected = ingredients.find((i) => i.id === value) ?? null;
  const [query, setQuery] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const inputEl = useRef<HTMLInputElement | null>(null);
  // Mirrors the committed name outside React's render cycle. commit() moving
  // focus to the next field (e.g. quantity) fires this input's onBlur
  // synchronously, before React has re-rendered with the new `value` prop —
  // reading `selected` there would see the stale pre-commit ingredient. This
  // ref is updated the instant a commit happens, so the deferred blur reset
  // below always reads the real just-picked name instead of racing it.
  const nameRef = useRef(selected?.name ?? "");

  // Keep the displayed text in sync when the committed value changes from
  // outside (e.g. a line is cleared) without clobbering active typing.
  useEffect(() => {
    if (document.activeElement !== inputEl.current) {
      nameRef.current = selected?.name ?? "";
      setQuery(nameRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const options = useMemo(() => {
    const excluded = new Set(excludeIds.filter((id) => id !== value));
    const pool = ingredients.filter((i) => !excluded.has(i.id));
    const q = query.trim().toLowerCase();
    const filtered = q ? pool.filter((i) => i.name.toLowerCase().includes(q)) : pool;
    return filtered.slice(0, MAX_OPTIONS);
  }, [ingredients, excludeIds, value, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function commit(ingredient: Ingredient | null) {
    nameRef.current = ingredient?.name ?? "";
    onCommit(ingredient?.id ?? "");
    setQuery(nameRef.current);
    setOpen(false);
  }

  function commitAndAdvance(ingredient: Ingredient) {
    commit(ingredient);
    onCommitNext?.();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = options[activeIndex];
      if (pick) commitAndAdvance(pick);
    } else if (e.key === "Tab") {
      // Don't preventDefault — let Tab move focus naturally. If something is
      // highlighted, commit it first so the value lands before focus leaves.
      const pick = options[activeIndex];
      if (open && pick) commit(pick);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery(nameRef.current);
    }
  }

  return (
    <div className="relative">
      <input
        ref={(el) => {
          inputEl.current = el;
          inputRef?.(el);
        }}
        className="field"
        autoFocus={autoFocus}
        value={query}
        placeholder="Type to search ingredient…"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          if (value) {
            nameRef.current = ""; // typing invalidates the previous commit
            onCommit("");
          }
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer so a click on an option (which also blurs the input) can
          // register before we snap the text back to the committed value.
          setTimeout(() => setQuery(nameRef.current), 150);
        }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={open && options.length ? `${listId}-option-${activeIndex}` : undefined}
      />
      {open && options.length > 0 && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="panel absolute z-30 mt-1 max-h-64 w-full overflow-y-auto p-1"
          style={{ borderColor: "var(--line)" }}
        >
          {options.map((opt, idx) => (
            <div
              key={opt.id}
              id={`${listId}-option-${idx}`}
              role="option"
              aria-selected={idx === activeIndex}
              ref={(el) => {
                optionRefs.current[idx] = el;
              }}
              className="cursor-pointer rounded-lg px-2.5 py-1.5 text-sm"
              style={{
                background: idx === activeIndex ? "var(--accent-soft)" : "transparent",
                color: idx === activeIndex ? "var(--accent)" : "var(--ink)",
              }}
              onMouseEnter={() => setActiveIndex(idx)}
              // onMouseDown (not onClick) fires before the input's onBlur reset.
              onMouseDown={(e) => {
                e.preventDefault();
                commitAndAdvance(opt);
              }}
            >
              {opt.name} <span style={{ color: "var(--muted)" }}>({opt.unit})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

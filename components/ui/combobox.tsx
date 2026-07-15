'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { inputCls } from '@/components/ui';

/**
 * Combobox (59047802) — a reusable, searchable, keyboard-navigable single-select. Built for the Personnel
 * Profile Nationality field, whose catalog grew to the full ISO 3166-1 demonym set (≈197 options) and needs
 * type-ahead filtering instead of a plain native <select>.
 *
 * FORM-COMPATIBLE by design: it renders a hidden <input name={name}> carrying the selected `value`, so it is
 * a drop-in for `ProfileOptionSelect` inside a server-action <form> — `setPersonAction` /
 * `assertProfileValueAllowed` are unchanged and still see a single scalar under the same field name.
 *
 * LEGACY-VALUE TOLERANCE (parity with ProfileOptionSelect): if the stored `value` is not among `options`
 * (renamed / deactivated / free-text-imported), it is shown as an extra, PRE-SELECTED entry tagged with
 * `legacySuffix` so a Save never blanks it. Clearing to "" (the placeholder row) is always allowed.
 *
 * Pure presentation — no data deps — so it is safe to import from either client or (indirectly) RSC trees.
 */
export type ComboboxOption = { value: string; label: string };

export function Combobox({
  name,
  value,
  options,
  placeholder,
  searchPlaceholder,
  noResultsLabel,
  legacySuffix,
  className,
}: {
  name: string;
  value: string | null | undefined;
  options: ComboboxOption[];
  placeholder: string;
  searchPlaceholder: string;
  noResultsLabel: string;
  legacySuffix: string;
  className?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);

  const initial = value ?? '';
  const [selected, setSelected] = useState(initial);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  // The stored value may be off-catalog (legacy). Surface it as an extra pre-selected option so it renders
  // as the current selection and survives a save. Empty selection just shows the placeholder.
  const legacy =
    selected !== '' && !options.some((o) => o.value === selected)
      ? { value: selected, label: `${selected} ${legacySuffix}` }
      : null;

  // The full row set the dropdown offers: an empty "clear" row, then any legacy value, then the catalog.
  const allRows = useMemo<ComboboxOption[]>(
    () => [{ value: '', label: placeholder }, ...(legacy ? [legacy] : []), ...options],
    [options, legacy, placeholder],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    // Always keep the clear/placeholder row reachable; filter the rest by case-insensitive substring.
    return allRows.filter((r) => r.value === '' || r.label.toLowerCase().includes(q) || r.value.toLowerCase().includes(q));
  }, [allRows, query]);

  const selectedLabel = allRows.find((r) => r.value === selected)?.label ?? placeholder;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // On open: focus the search box and point the active row at the current selection.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const idx = Math.max(0, filtered.findIndex((r) => r.value === selected));
    setActiveIdx(idx);
    const raf = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the active option scrolled into view as the highlight moves.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIdx]?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const commit = (v: string) => {
    setSelected(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (open) {
        e.preventDefault();
        const row = filtered[activeIdx];
        if (row) commit(row.value);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      setActiveIdx(filtered.length - 1);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      {/* The value the surrounding <form> submits — same field name a native <select> would post. */}
      <input type="hidden" name={name} value={selected} />
      <button
        type="button"
        className={`${className ?? inputCls} flex items-center justify-between gap-2 text-left`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <span className={selected === '' ? 'truncate text-muted-foreground' : 'truncate'}>{selectedLabel}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="shrink-0 opacity-60" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          <div className="p-1.5">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIdx(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              className={inputCls}
              aria-controls={listId}
              aria-autocomplete="list"
            />
          </div>
          <ul id={listId} role="listbox" className="max-h-60 overflow-y-auto p-1 text-sm">
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-muted-foreground">{noResultsLabel}</li>
            ) : (
              filtered.map((r, i) => {
                const isSelected = r.value === selected;
                const isActive = i === activeIdx;
                return (
                  <li
                    key={r.value === '' ? '__empty__' : r.value}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIdx(i)}
                    onMouseDown={(e) => {
                      // mousedown (not click) so we commit before the outside-click handler closes us.
                      e.preventDefault();
                      commit(r.value);
                    }}
                    className={`cursor-pointer truncate rounded px-2 py-1.5 ${
                      isActive ? 'bg-accent text-accent-foreground' : ''
                    } ${isSelected ? 'font-medium' : ''} ${r.value === '' ? 'text-muted-foreground' : ''}`}
                  >
                    {r.label}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

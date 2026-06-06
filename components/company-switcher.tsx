'use client';

import { useState } from 'react';
import { setCompanyScope } from '@/app/scope-actions';

/** Odoo-style multi-company context: shows the active company/companies, multi-select to re-scope. */
export function CompanySwitcher({
  companies,
  selected,
}: {
  companies: { id: string; name: string }[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  if (companies.length === 0) return null;

  const selSet = new Set(selected);
  const label =
    selSet.size >= companies.length
      ? 'All companies'
      : selSet.size === 1
        ? (companies.find((c) => selSet.has(c.id))?.name ?? '1 company')
        : `${selSet.size} companies`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        <span className="size-2 rounded-full bg-primary" />
        <span className="max-w-[14rem] truncate">{label}</span>
        <span className="text-xs text-muted-foreground">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <form
            action={setCompanyScope}
            className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Company context
            </div>
            {companies.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  name="companyId"
                  value={c.id}
                  defaultChecked={selSet.has(c.id)}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                  className="size-4 accent-[var(--color-primary)]"
                />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </form>
        </>
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { setCompanyScope } from '@/app/scope-actions';
import { cn } from '@/lib/utils';
import { useIsMonolith } from '@/components/ui-theme-context';

/**
 * Odoo-style multi-company context: shows the active company/companies, multi-select to re-scope.
 *
 * 95aafb3c — bulk Select all / Deselect all. Load-bearing server fact behind the two design calls
 * below: getScopeIds (lib/scope.ts) coerces an ABSENT or EMPTY company_scope cookie back to ALL
 * allowed ids. So there is no persisted "zero companies" state — empty and all-ticked both resolve
 * to all.
 *
 * - Select all SUBMITS (one click back to the full view). It is a bulk PROGRAMMATIC change, so the
 *   new checked state must be committed to the DOM before requestSubmit() serialises the form —
 *   hence flushSync. Without it the post would carry the stale prior subset.
 * - Deselect all does NOT submit. An empty post writes an empty cookie, which the resolver turns
 *   straight back into every company; the re-resolved `selected` prop would then silently re-tick
 *   every box — the opposite of the button's promise. Instead it is a client-side "start fresh"
 *   clear: the boxes empty, the view stays where it is, and the user's next tick submits their pick.
 *
 * The checkbox list is therefore CONTROLLED (mirroring components/ui/multi-select-popover.tsx), so
 * the button label can track the pending picks live. Note the deliberate split of truth: the trigger
 * label reflects `selected` (the committed, active scope = what you are viewing), the in-popover
 * button reflects `sel` (the pending pick). Right after Deselect all those legitimately differ.
 */
/**
 * The ACTIVE scope's label — what the trigger shows. Exported (r398) so the Monolith status line says the
 * same words for the same scope instead of a second copy of this rule drifting from the first.
 */
export function companyScopeLabel(
  t: (key: 'allCompanies' | 'companyCount', values?: { count: number }) => string,
  companies: { id: string; name: string }[],
  selected: string[],
): string {
  const selSet = new Set(selected);
  return selSet.size >= companies.length
    ? t('allCompanies')
    : selSet.size === 1
      ? (companies.find((c) => selSet.has(c.id))?.name ?? t('companyCount', { count: 1 }))
      : t('companyCount', { count: selSet.size });
}

export function CompanySwitcher({
  companies,
  selected,
}: {
  companies: { id: string; name: string }[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set(selected));
  const t = useTranslations('topbar');
  const monolith = useIsMonolith();

  // Resync the pending picks from the server-resolved scope after every revalidation, WITHOUT
  // remounting (a key on the component would tear down and close the popover mid-pick). The Set is
  // rebuilt from the same joined string the effect depends on, so there is no stale-array dep.
  const selectedKey = selected.join(',');
  useEffect(() => {
    setSel(new Set(selectedKey ? selectedKey.split(',') : []));
  }, [selectedKey]);

  if (companies.length === 0) return null;

  const label = companyScopeLabel(t, companies, selected);

  // every() over the rendered companies, NOT a size compare: a size compare misfires if `sel` ever
  // holds an id that is not in the listed companies.
  const allSelected = companies.length > 0 && companies.every((c) => sel.has(c.id));

  return (
    // min-w-0 is load-bearing (overlap guard d9b81f8d): this div is a flex item of the topbar's
    // right cluster. Without it the item's automatic min-width:auto floor holds the full label
    // width, and when the right grid track is narrower than the cluster, justify-end spills the
    // excess LEFTWARD over the centre search box. With min-w-0 + max-w-full on the trigger the
    // label truncates (ellipsis) instead — the company name shortens before anything can collide.
    // r416 — in Monolith the top line also carries the route path, the DEV badge and the clock; with a bare
    // min-w-0 the switcher was the child crushed to 0px on a phone, so it could not be tapped. It keeps
    // room for its ▾ and a few letters; the label still truncates, the route path gives way first.
    <div className="relative min-w-0 monolith:min-w-[5.5rem]">
      <button
        type="button"
        onClick={() => {
          // Reset the pending picks when the popover OPENS. Deselect all does not submit, so an
          // abandoned clear would otherwise linger on reopen.
          if (!open) setSel(new Set(selectedKey ? selectedKey.split(',') : []));
          setOpen(!open);
        }}
        aria-expanded={open}
        className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98] monolith:gap-1.5 monolith:rounded-none monolith:border-0 monolith:bg-transparent monolith:px-0 monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid monolith:hover:bg-transparent monolith:hover:text-ink monolith:active:scale-100"
      >
        <span className="size-2 shrink-0 rounded-full bg-primary monolith:hidden" />
        <span className="min-w-0 max-w-[14rem] truncate">{label}</span>
        {/* r398 — Monolith's top line names the company as mono text with a ▾ (README §3). */}
        {monolith && (
          <span aria-hidden className="shrink-0 text-ink">
            ▾
          </span>
        )}
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-snappy',
            open && 'rotate-180',
            'monolith:hidden',
          )}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <form
            action={setCompanyScope}
            className="absolute right-0 z-50 mt-1 w-64 origin-top-right scale-100 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground opacity-100 shadow-lg transition duration-150 ease-snappy starting:scale-95 starting:opacity-0"
          >
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('companyContext')}
            </div>
            {/* type="button" is REQUIRED: a bare button inside a form defaults to type=submit and
                would fire a native submit of the PRE-change set alongside our own. */}
            <button
              type="button"
              onClick={(e) => {
                const form = e.currentTarget.form;
                if (allSelected) {
                  setSel(new Set());
                  return; // client-side clear only — see the docblock
                }
                flushSync(() => setSel(new Set(companies.map((c) => c.id))));
                form?.requestSubmit();
              }}
              className="mb-0.5 flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs font-medium text-primary transition-colors hover:bg-muted"
            >
              {allSelected ? t('deselectAll') : t('selectAll')}
            </button>
            {companies.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
              >
                <input
                  type="checkbox"
                  name="companyId"
                  value={c.id}
                  checked={sel.has(c.id)}
                  onChange={(e) => {
                    // The native tick is already in the DOM when onChange fires, so this synchronous
                    // submit posts the correct companyId set for this one change (no flushSync).
                    const form = e.currentTarget.form;
                    const next = new Set(sel);
                    if (e.currentTarget.checked) next.add(c.id);
                    else next.delete(c.id);
                    setSel(next);
                    form?.requestSubmit();
                  }}
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

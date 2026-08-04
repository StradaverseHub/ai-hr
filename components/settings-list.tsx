import type { ReactNode } from 'react';
import Link from 'next/link';
import { inputCls } from '@/components/ui';

/**
 * THE SYSTEM SETTINGS LIST IDIOM (feedback 7b5f18c3 + 1b87e8a0).
 *
 * Both of those items asked for "the standard UI/UX used throughout the System Settings module". Two
 * things were true when they were written, and neither is what the plans assumed:
 *
 *   • Inside SYSTEM_SETTINGS_NODE there really was no shared list shape — Employee ID, Dashboard Cards,
 *     System Labels and Movement Settings each hand-rolled their own table classes and toolbar.
 *   • But the shape itself was NOT missing from the product. /admin/pay-components has shipped it for
 *     rounds: a Card, a toolbar of [primary action · search · status filter], the house table, and row
 *     actions on the right, with the maintenance form on a dedicated route.
 *
 * So this module does not invent a standard — it LIFTS the pay-components toolbar into one place so the
 * two screens converge on it instead of on two private copies. That is the whole reason the two items
 * were built in one round: the second screen imports the same four pieces the first one does, and
 * test/settings-list-idiom.test.ts fails if either stops.
 *
 * Deliberately NOT here: pagination. The shared contract for that is lib/pagination + components/Pager
 * (test/pagination.test.ts pins the converted surfaces), and 1b87e8a0's plan omits paging on purpose —
 * a settings catalogue is short and searching beats paging on it. A sixth hand-rolled pager must never
 * grow out of this file.
 *
 * SERVER-ONLY BY CONSTRUCTION. No 'use client', and no prop is a function — labels and hrefs arrive
 * pre-computed from the calling server component. That is what keeps these usable from a server page
 * without the r123 boundary defect (test/server-client-boundary.test.ts), and it is why the status
 * filter takes an array of {value, href, label} rather than a `hrefFor` callback.
 *
 * NO t() CALLS. Every visible string is passed in, so each calling page keeps ONE translation namespace
 * and test/i18n-coverage.test.ts Check C can still statically resolve its keys (Check C skips any file
 * that opens two namespaces).
 */

/** The row-action link look: Edit and its siblings on the right of a settings row. */
export const rowActionCls = 'text-xs font-medium text-primary hover:underline';
/** The quieter row action (activate / deactivate) — same size, no primary colour. */
export const rowActionMutedCls =
  'text-xs font-medium text-muted-foreground hover:text-foreground hover:underline';
/** The right-aligned action cluster inside a row's last cell. */
export const rowActionsCls = 'flex flex-wrap items-center justify-end gap-3';

/** The toolbar strip under a Card's SectionHeader: primary action, search, filters, right-aligned extras. */
export function SettingsToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 px-4 pb-3">{children}</div>;
}

/**
 * The search box. A plain GET form, so the query lands in the address bar and the whole screen stays
 * server-rendered with nothing to persist — submitting is Enter, exactly as on /admin/pay-components.
 * `hidden` carries the rest of the current view (status, sort) so searching does not silently reset it.
 */
export function SettingsSearch({
  action,
  value,
  placeholder,
  hidden,
}: {
  action: string;
  value: string;
  placeholder: string;
  hidden?: Record<string, string | undefined>;
}) {
  return (
    <form action={action} method="get" className="flex items-center gap-2">
      {Object.entries(hidden ?? {}).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      <input
        type="search"
        name="q"
        defaultValue={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`${inputCls} w-56`}
      />
    </form>
  );
}

/** Active / Inactive / All — the three-way status filter every settings catalogue needs. */
export type SettingsStatus = 'active' | 'inactive' | 'all';

/** Parse `?status=`; anything unrecognised (including absent) means Active, the useful default. */
export function parseSettingsStatus(raw: string | undefined): SettingsStatus {
  return raw === 'inactive' || raw === 'all' ? raw : 'active';
}

export function SettingsStatusFilter({
  current,
  options,
}: {
  current: SettingsStatus;
  options: readonly { value: SettingsStatus; href: string; label: string }[];
}) {
  return (
    <nav className="flex items-center gap-1 rounded-lg border border-border p-1 text-xs font-medium">
      {options.map((o) => (
        <Link
          key={o.value}
          href={o.href}
          aria-current={current === o.value ? 'page' : undefined}
          className={`rounded-md px-2.5 py-1 transition-colors ${
            current === o.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

/** `?dir=` — ascending unless the address explicitly says otherwise. */
export type SortDir = 'asc' | 'desc';
export const parseSortDir = (raw: string | undefined): SortDir => (raw === 'desc' ? 'desc' : 'asc');

/**
 * A sortable column heading. Renders inside a <th>, so the caller keeps thCls on the cell itself and
 * this only owns the link. `href` is the address that would apply THIS column's sort — the caller
 * flips the direction when the column is already the active one.
 */
export function SortHeader({
  label,
  href,
  active,
  dir,
}: {
  label: string;
  href: string;
  active: boolean;
  dir: SortDir;
}) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 hover:text-foreground">
      {label}
      <span aria-hidden className={active ? 'text-foreground' : 'text-muted-foreground/40'}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </Link>
  );
}

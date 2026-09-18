'use client';

/**
 * r307 — the People list's "what is needed next" cell, and the panel it opens.
 *
 * WHY A CELL-SIZED ISLAND. The directory table stays a server component: its markup, its row-link
 * overlay (420ebab5, measured in WebKit) and its pager are unchanged, and only this one cell is
 * interactive. Replacing the whole table with a client island would have put every one of those
 * behaviours back on trial to gain nothing.
 *
 * EVERY STRING ARRIVES RESOLVED. The page reads the labels — including the gap names, which come from
 * `controlTower.readinessScreen.gap.*`, the SAME catalogue the Record Readiness screen uses — so this
 * island holds no dynamic `t()` key. That is the idiom app/personnel/page.tsx already states for its
 * filter panel, and it is what keeps a computed key from silently painting itself at a user.
 *
 * IT SHOWS ONLY ABSENCES, NEVER VALUES. A gap is "no bank account on record", not the account number;
 * there is no salary here and no statutory identifier. The page decides who may see even that much
 * (admins today — a manager's next action is their approval queue, not somebody's statutory record).
 */
import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';

/** One missing thing, already named and already explained, in the viewer's language. */
export type NeedsItem = {
  /** e.g. "No bank account" */
  label: string;
  /** e.g. "stops payment" — the consequence, which is what makes the row worth acting on. */
  consequence: string;
  /** The catalogue's own fix guidance for this gap. */
  fix: string;
  tone: 'critical' | 'warning';
};

export type NeedsPerson = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  company: string;
  department: string | null;
  statusLabel: string;
  hiredOn: string;
  items: NeedsItem[];
  /** "+2 more", already counted and already translated by the page — never a template to fill here:
   *  a count belongs to next-intl's formatter, which lives on the server side of this boundary. */
  moreLabel: string | null;
};

export function NeedsActionCell({
  person,
  labels,
}: {
  person: NeedsPerson;
  labels: {
    needed: string;
    blockers: string;
    facts: string;
    completeRecord: string;
    close: string;
    colCode: string;
    colCompany: string;
    colDepartment: string;
    colStatus: string;
    colHired: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const first = person.items[0];
  if (!first) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // relative + z: this cell sits inside a row whose whole area is covered by a link overlay
        // (420ebab5). Without lifting the button above it, the click opens the record page instead of
        // the panel — the overlay is doing exactly what it was built to do.
        className="relative z-10 flex w-full items-start gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted/60"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <AlertTriangle
          className={`mt-0.5 size-3.5 shrink-0 ${first.tone === 'critical' ? 'text-critical' : 'text-warning'}`}
          strokeWidth={2}
        />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-foreground">{first.label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {first.consequence}
            {person.moreLabel ? ` · ${person.moreLabel}` : ''}
          </span>
        </span>
      </button>

      <Drawer open={open} onOpenChange={setOpen} title={person.name} closeLabel={labels.close} width="narrow">
        <div className="space-y-5">
          <div className="rounded-xl bg-muted/60 px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{labels.needed}</p>
            <p className="mt-0.5 font-semibold">{first.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{first.fix}</p>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">{labels.blockers}</h3>
            <ul className="space-y-2">
              {person.items.map((item) => (
                <li
                  key={item.label}
                  className="rounded-xl px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--border)]"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10.5px] font-semibold ${
                        item.tone === 'critical' ? 'bg-critical-bg text-critical' : 'bg-warning-bg text-warning'
                      }`}
                    >
                      {item.consequence}
                    </span>
                    <span className="text-[13px] font-medium">{item.label}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{item.fix}</p>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold">{labels.facts}</h3>
            <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[13px]">
              <dt className="text-muted-foreground">{labels.colCode}</dt>
              <dd className="text-right font-medium">{person.employeeCode ?? '—'}</dd>
              <dt className="text-muted-foreground">{labels.colCompany}</dt>
              <dd className="text-right font-medium">{person.company}</dd>
              <dt className="text-muted-foreground">{labels.colDepartment}</dt>
              <dd className="text-right font-medium">{person.department ?? '—'}</dd>
              <dt className="text-muted-foreground">{labels.colStatus}</dt>
              <dd className="text-right font-medium">{person.statusLabel}</dd>
              <dt className="text-muted-foreground">{labels.colHired}</dt>
              <dd className="text-right font-medium">{person.hiredOn}</dd>
            </dl>
          </div>

          {/* The one action: the screen that fixes it. Nothing is written from this panel — a record
              change is an audited edit on the record itself, not a side effect of a list. */}
          <Link
            href={`/admin/personnel/${person.employmentId}`}
            className="flex items-center justify-between rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-primary-foreground"
          >
            {labels.completeRecord}
            <ChevronRight className="size-4" />
          </Link>
        </div>
      </Drawer>
    </>
  );
}

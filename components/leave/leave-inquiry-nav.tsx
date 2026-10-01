import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * Navigation for the HR-admin leave INQUIRY surface (feedback 20c699f8 / 953be4b0 / 026e16b9 / d990f14a).
 *
 * Three destinations, in the reporter's order: the employee listing you pick from, the picked employee's
 * balances, and the transactions behind one of those balances.
 *
 * d990f14a — A HORIZONTAL PILL BAR, AND THE HISTORY IS THE ARGUMENT. This was a LEFT-SIDE rail for three
 * rounds because 20c699f8 asked for one in those words. 026e16b9 then reported that it was squeezing the
 * balances table and we narrowed it from w-56 to sm:w-44, which recovered most of the overflow and not all
 * of it — its own guard header records 1038px of table area for 1047px of columns at a 1512px window.
 * This item finishes that job the only way it can be finished: a bar costs the table NOTHING, where a
 * narrower column still cost it 192px (sm:w-44 = 11rem = 176px, plus the gap-4 beside it = 16px).
 *
 * So the rail is gone, the pages render this BETWEEN the search bar and the table, and the table gets the
 * full width of the panel. Below sm nothing changes in kind: this was already a horizontal overflow-x-auto
 * strip there, and still is — the change brings the desktop into line with the phone, not the reverse.
 *
 * IT IS A NAV, NOT A TABLIST, and that is deliberate rather than an oversight of the segmented-control
 * look. The three are separate ROUTES: every pill is a navigation, not a panel swap. `role="tablist"` with
 * `aria-selected` would tell a screen reader these are panels of one page and that activating one changes
 * nothing but the view, which is false — so it stays a `nav` with `aria-current="page"`, exactly as it was
 * when it was a rail. Only the paint changed.
 *
 * Employee Details points at `/leave/tracker` — the Team Leave Tracker row, which is where feedback
 * 388e53c2 moved the HR administrator's way in. It used to point at `/leave`, and that was the whole
 * complaint: the sidebar kept "My Leave" lit while an administrator read somebody else's leave record.
 *
 * THE OTHER TWO HREFS ARE DELIBERATELY UNCHANGED. Employee Balances and Employee Leave Record keep the
 * exact addresses they have always had, so saved links and the export links already in circulation stay
 * valid — 388e53c2 moved the ENTRY POINT and nothing else.
 */

type Tab = 'balances' | 'records';

/**
 * d990f14a — WHICH FILTERS SURVIVE A TAB CHANGE, decided per DESTINATION rather than by copying the query
 * string across. `emp` has always been threaded (losing the selection on each hop is what makes an inquiry
 * screen unusable); the reporter's complaint was that everything else cleared, which a tab bar sitting
 * directly under the search bar makes look like a defect rather than a reset.
 *
 * An ALLOWLIST, not a passthrough, because the three screens do not read the same query:
 *   · `type` is leave-type ids on BOTH balances and records — same meaning, safe to carry.
 *   · `q` is a leave-code search on both ("Search leave code" / "Search employee ID, name or leave code"),
 *     so a leave code carries correctly. Records' box ALSO matches a request reference, and carrying one of
 *     those to balances filters the table to nothing — visible in the box that carried it and undone in one
 *     click, which is the honest trade for keeping a typed leave code alive.
 *   · `asOf` is BALANCES-ONLY and is never carried: records dates a leave by its own from/to and details
 *     has no date at all. Carrying it would put a value in a query the destination cannot honour.
 *   · details reads its own `edQ` / `edCompany` / `edDept` / `edStatus` / `edPage` namespace — an employee
 *     search, not a leave-code one. Nothing crosses into it, so it carries `emp` alone.
 */
const CARRY: Record<Tab, readonly string[]> = {
  balances: ['q', 'type'],
  records: ['q', 'type'],
};

export type InquiryCarry = Readonly<Record<string, string | readonly string[] | undefined>>;

export async function LeaveInquiryNav({
  active,
  employmentId,
  carry,
}: {
  active: Tab;
  employmentId?: string;
  /** The CURRENT screen's filter values. Only the keys in CARRY[destination] are ever used. */
  carry?: InquiryCarry;
}) {
  const t = await getTranslations('leave.inquiry');

  const hrefFor = (base: string, tab: Tab) => {
    const p = new URLSearchParams();
    if (employmentId) p.set('emp', employmentId);
    for (const key of CARRY[tab]) {
      const value = carry?.[key];
      if (value == null) continue;
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one) p.append(key, String(one));
      }
    }
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const tabs = [
    { key: 'balances', href: hrefFor('/leave/employee-balances', 'balances'), label: t('employeeBalances') },
    { key: 'records', href: hrefFor('/leave/employee-records', 'records'), label: t('employeeLeaveRecord') },
  ] as const;

  return (
    <nav aria-label={t('navLabel')}>
      {/* overflow-x-auto at EVERY width now: six locales share this bar and the longest label set must be
          reachable on a narrow window by scrolling the bar, never by wrapping it onto a second line and
          pushing the table down. */}
      <ul className="flex gap-1.5 overflow-x-auto">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={active === tab.key ? 'page' : undefined}
              className={`block whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                active === tab.key
                  ? 'border-primary/40 bg-primary/10 font-semibold text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

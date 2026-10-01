import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/** r378 b594a6e0: two full-width inquiry destinations, with employee search context
 * carried in its own picker namespace. The retired Employee Details listing now
 * redirects to balances; explicit tracker calendar intent remains a separate journey.
 * Navigation uses links and aria-current because these are independent routes.
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
  balances: ['q', 'type', 'pickerQ', 'pickerCompany', 'pickerBusinessUnit', 'pickerDepartment', 'pickerStatus'],
  records: ['q', 'type', 'pickerQ', 'pickerCompany', 'pickerBusinessUnit', 'pickerDepartment', 'pickerStatus'],
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

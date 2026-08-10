import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * Left-side navigation for the HR-admin leave INQUIRY surface (feedback 20c699f8 / 953be4b0).
 *
 * Three destinations, in the reporter's order: the employee listing you pick from, the picked employee's
 * balances, and the transactions behind one of those balances. Vertical rather than the horizontal
 * `LeaveTabs` strip because the reporter asked for an internal LEFT-side nav, and because a balance row
 * drills into the record page — a hierarchy the flat tab strip would flatten.
 *
 * Employee Details points at `/leave/tracker` — the Team Leave Tracker row, which is where feedback
 * 388e53c2 moved the HR administrator's way in. It used to point at `/leave`, and that was the whole
 * complaint: the sidebar kept "My Leave" lit while an administrator read somebody else's leave record.
 *
 * THE OTHER TWO HREFS ARE DELIBERATELY UNCHANGED. Employee Balances and Employee Leave Record keep the
 * exact addresses they have always had, so saved links and the export links already in circulation stay
 * valid — 388e53c2 moved the ENTRY POINT and nothing else.
 *
 * `emp` is threaded through every link so switching tab keeps the employee you are looking at — losing the
 * selection on each hop is the thing that makes an inquiry screen unusable.
 *
 * Width (feedback 026e16b9): the rail is `sm:w-44`, narrowed from `w-56`. Measured in a browser, the old
 * width plus its gap took 248px off a 1232px content area and left the Employee Balances table overflowing
 * by 136px — a rail holding three short labels was costing the table a horizontal scrollbar. Nothing else
 * about the nav changed; the longest label still fits on one line at this width.
 */
export async function LeaveInquiryNav({
  active,
  employmentId,
}: {
  active: 'details' | 'balances' | 'records';
  employmentId?: string;
}) {
  const t = await getTranslations('leave.inquiry');
  const withEmp = (href: string) => (employmentId ? `${href}${href.includes('?') ? '&' : '?'}emp=${employmentId}` : href);
  const tabs = [
    { key: 'details', href: withEmp('/leave/tracker'), label: t('employeeDetails') },
    { key: 'balances', href: withEmp('/leave/employee-balances'), label: t('employeeBalances') },
    { key: 'records', href: withEmp('/leave/employee-records'), label: t('employeeLeaveRecord') },
  ] as const;
  return (
    <nav aria-label={t('navLabel')} className="shrink-0 sm:w-44">
      <ul className="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
        {tabs.map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={active === tab.key ? 'page' : undefined}
              className={`block whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors ${
                active === tab.key
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
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

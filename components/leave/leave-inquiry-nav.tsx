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
 * Employee Details points at `/leave`, the HR-admin landing page, which item 650b6eb8 turned into the
 * paginated employee listing an admin picks from. It stayed on that route rather than moving to one of its
 * own because "My Leave" is the menu entry the reporter wants to LAND on Employee Details.
 *
 * `emp` is threaded through every link so switching tab keeps the employee you are looking at — losing the
 * selection on each hop is the thing that makes an inquiry screen unusable.
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
    { key: 'details', href: withEmp('/leave'), label: t('employeeDetails') },
    { key: 'balances', href: withEmp('/leave/employee-balances'), label: t('employeeBalances') },
    { key: 'records', href: withEmp('/leave/employee-records'), label: t('employeeLeaveRecord') },
  ] as const;
  return (
    <nav aria-label={t('navLabel')} className="shrink-0 sm:w-56">
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

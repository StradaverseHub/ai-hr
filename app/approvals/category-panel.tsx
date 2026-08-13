import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  CalendarDays,
  CalendarRange,
  CalendarPlus,
  Clock,
  History,
  ListChecks,
  MapPin,
  MessageSquareText,
  Receipt,
  ScrollText,
  ShieldCheck,
  Timer,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  ADMIN_ONLY_CATEGORIES,
  PANEL_GROUPS,
  type ApprovalCategory,
  type ApprovalCategoryGroup,
} from '@/lib/approvals-categories';

/**
 * Internal approval-task navigation panel (feedback 2dec6406). A SERVER component: plain Links to
 * /approvals?category=X (preserving the current ?sort=), so switching categories is ordinary navigation —
 * no client state, no change to the main system sidebar. Every count here is handed down from the SAME
 * in-memory pending lists the page sections render, so a panel badge always equals its section heading.
 * Icons reuse the lucide set the main sidebar already draws from.
 */

type PanelCategory = Exclude<ApprovalCategory, 'all'>;

const ICONS: Record<PanelCategory, LucideIcon> = {
  leave: CalendarDays,
  leaveCancellation: CalendarRange,
  // 5ff7daff — a claim to be CREDITED for time already worked, so a calendar with a plus rather than the
  // plain one that means "time off requested".
  replacementLeave: CalendarPlus,
  attendance: Clock,
  overtime: Timer,
  claim: Receipt,
  travel: MapPin,
  profileChanges: UserRound,
  resignations: ScrollText,
  managerReviews: MessageSquareText,
  hrReviews: ShieldCheck,
};

/** Short panel labels — existing section-title keys where they read well; overtime gets its own key. */
const LABEL_KEY: Record<PanelCategory, string> = {
  leave: 'leaveRequests',
  leaveCancellation: 'leaveCancellationTitle',
  replacementLeave: 'replacementLeaveTitle',
  attendance: 'attendanceCorrections',
  overtime: 'categoryOvertime',
  claim: 'claims',
  travel: 'travelRequests',
  profileChanges: 'profileChanges',
  resignations: 'resignations',
  managerReviews: 'managerReviews',
  hrReviews: 'hrReviews',
};

const GROUP_LABEL_KEY: Record<ApprovalCategoryGroup, string> = {
  leave: 'categoryGroupLeave',
  attendance: 'categoryGroupAttendance',
  claims: 'categoryGroupClaims',
  travel: 'categoryGroupTravel',
  people: 'categoryGroupPeople',
};

function itemHref(cat: ApprovalCategory, sort: string | undefined): string {
  const qs = new URLSearchParams();
  if (cat !== 'all') qs.set('category', cat);
  if (sort) qs.set('sort', sort);
  const s = qs.toString();
  return s ? `/approvals?${s}` : '/approvals';
}

export async function CategoryPanel({
  category,
  sort,
  counts,
  allCount,
  admin,
}: {
  /** The currently selected category (already parsed + admin-coerced by the page). */
  category: ApprovalCategory;
  /** Raw ?sort= value to preserve on every link (undefined/'' = default, omitted). */
  sort?: string;
  /** Pending count per category — from the page's in-memory lists, NOT a separate SQL count. */
  counts: Record<PanelCategory, number>;
  /** Pending total for the All entry (= the page-header total on the unfiltered view). */
  allCount: number;
  admin: boolean;
}) {
  const t = await getTranslations('approvals');

  const item = (cat: ApprovalCategory, label: string, count: number, Icon: LucideIcon) => {
    const selected = category === cat;
    return (
      <Link
        key={cat}
        href={itemHref(cat, sort)}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
          selected
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {/* Pending badge — same muted "(n)" figure family as SectionHeader, right-aligned tabular-nums. */}
        <span className={cn('shrink-0 text-xs tabular-nums', selected ? 'text-primary' : 'text-muted-foreground')}>
          {count}
        </span>
      </Link>
    );
  };

  return (
    <Card className="p-2">
      <nav aria-label={t('title')} className="space-y-3">
        {item('all', t('categoryAll'), allCount, ListChecks)}
        {PANEL_GROUPS.map(({ group, categories }) => {
          const visible = categories.filter((c) => admin || !ADMIN_ONLY_CATEGORIES.includes(c));
          if (visible.length === 0) return null;
          return (
            <div key={group} className="space-y-0.5">
              <div className="px-2.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t(GROUP_LABEL_KEY[group])}
              </div>
              {visible.map((c) => item(c, t(LABEL_KEY[c]), counts[c], ICONS[c]))}
            </div>
          );
        })}

        {/* Approval History (feedback 77a4049f) — previously reachable ONLY through the notification
            bell's "View full history" link, so anyone who did not already know that route could not
            find it at all. The page itself already existed; this is the way in.

            Deliberately NOT rendered through `item()`: that helper takes an ApprovalCategory and
            filters the list in place (/approvals?category=X) with a pending count on the right. This is
            a different kind of row — a destination, and one with no pending figure to show, since
            history is by definition what is no longer pending. Reusing `item()` would have meant
            inventing a fake category and a count of 0, which reads as "no history" rather than "not a
            count". Separated by a rule so the panel does not imply it is one more filter.

            No extra visibility gate: the whole panel only renders for someone who can already reach
            /approvals, and app/approvals/history has its own guard, so the link cannot grant access it
            would otherwise refuse. */}
        <div className="border-t pt-2">
          <Link
            href="/approvals/history"
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <History className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t('approvalHistory')}</span>
          </Link>
        </div>
      </nav>
    </Card>
  );
}

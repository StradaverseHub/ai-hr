import { getTranslations } from 'next-intl/server';

import type { SessionContext } from '@/db/client';
import { myEmployment } from '@/core/read';
import { noticesForEmployment, popupNoticeFor, unreadNoticeCount } from '@/core/notice';
import { dismissNoticePopupAction } from '@/app/notices/actions';
import { NoticeBoardCard } from './notice-board-card';
import { NoticePopup } from './notice-popup';

/**
 * 6e122302 — the two places a notice appears WITHOUT being asked for: the dashboard card and the
 * after-login popup.
 *
 * ── WHY THEY LIVE IN ONE SMALL FILE INSTEAD OF INSIDE app/page.tsx AND app/layout.tsx ──────────────────
 * i18n coverage. `test/i18n-coverage.test.ts` check C only verifies files that open exactly ONE
 * translation namespace, and both of those hosts already open more than one (app/page.tsx) or none at all
 * (app/layout.tsx). Dropping `getTranslations('notices')` into either would leave every string on these
 * two surfaces unverified — which is exactly how r127 shipped twelve labels that rendered as
 * MISSING_MESSAGE behind a green suite, a green build and a 200 response.
 *
 * This file opens ONE namespace, so every key below is checked. The hosts just mount the slots.
 *
 * Both slots resolve `myEmployment` themselves and render NOTHING when there is none — a principal with
 * no employment (an admin login not attached to a person) has no notices, which is correct rather than an
 * error, and neither surface should be a special case in its host.
 */

/** The dashboard's Notice Board card. Returns null when the viewer has no employment. */
export async function NoticeBoardCardSlot({ s }: { s: SessionContext }) {
  const t = await getTranslations('notices');
  const me = await myEmployment(s);
  if (!me) return null;
  const rows = await noticesForEmployment(s, me.employmentId);
  const unread = unreadNoticeCount(rows);
  return (
    <NoticeBoardCard
      // Five is a card, not a listing — "View all notices" is one click away and is where the rest live.
      items={rows.slice(0, 5).map((n) => ({ id: n.id, title: n.title, unread: n.firstViewedAt == null }))}
      unread={unread}
      title={t('cardTitle')}
      emptyLabel={t('cardEmpty')}
      viewAllLabel={t('cardViewAll')}
      newCountLabel={t('cardNewCount', { count: unread })}
    />
  );
}

/**
 * The after-login popup. At most ONE notice, chosen by `popupNoticeFor`; returns null when nothing is due.
 *
 * Mounted in the root layout beside the onboarding tour, which is the existing "show something after login
 * and remember that it was dismissed" precedent in this product.
 */
export async function NoticePopupSlot({ s }: { s: SessionContext }) {
  const t = await getTranslations('notices');
  const me = await myEmployment(s);
  if (!me) return null;
  const due = popupNoticeFor(await noticesForEmployment(s, me.employmentId));
  if (!due) return null;
  return (
    <NoticePopup
      noticeId={due.id}
      title={due.title}
      href={`/notices/${due.id}`}
      readLabel={t('popupRead')}
      dismissLabel={t('popupDismiss')}
      dismissAction={dismissNoticePopupAction}
    />
  );
}

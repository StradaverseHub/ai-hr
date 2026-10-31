import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import {
  LEAVE_CONFIG_RECORD_IDS,
  LEAVE_CONFIG_RECORD_LABEL_ID,
  leaveConfigRecordHref,
  leaveConfigRecordOf,
  leaveConfigScreenHref,
  leaveConfigScreenTitle,
} from '@/components/leave-config-map';
import { ResetRecordConfiguration } from '@/components/leave/reset-record-configuration';
import { ResetRecordBalances } from '@/components/leave/reset-record-balances';

/**
 * 7f69bd71 — RESET RECORDS (`/admin/leave-config/records`).
 *
 * ONE out-of-the-way place for the two read-only records that used to sit as everyday tabs — the
 * Configuration record as the third tab of Entitlements, the Balance record as the second tab of Leave
 * Adjustments. The reporter's complaint was fair: a record that does nothing day to day has no business
 * beside Leave types and Entitlement tables. What was NOT done is deleting either record or the screen
 * that shows it: they are the only place in the product where the figures a reset cleared still exist,
 * and four approved plans (6e9a126e, c8052ae3, fe9c73bc, 492da418) promised the reporter a record they
 * could open and download. This page keeps that promise one click further away.
 *
 * A SUB-SCREEN OF THE LEAVE ADJUSTMENTS ROW, NOT A ROW AND NOT A TAB. It is reached only from the
 * "Records of past resets" link at the foot of Adjust balances, it carries a back link to that page, and
 * the Leave Adjustments row stays lit on it (`ownedSubpaths`, packs/leave/index.ts). It is therefore
 * DELIBERATELY NOT read through `leaveConfigPageHeader` and mounts NO `LeaveConfigMap`: the r266 rule
 * that a page's heading is its submenu row is a property of map ids, and this page has none — the same
 * shape as the Shift arrangement page (r265), a page of its own under a row.
 *
 * TWO SUB-TABS, `?record=configuration` (the default) and `?record=balances`, each EXACTLY what its old
 * tab showed: the explanation, the Record taken picker, Show, Download as CSV and the table, moved into
 * components/leave/reset-record-configuration.tsx and reset-record-balances.tsx without redesign. The
 * sub-tab labels are the tab strings the reporter already knows (`admin.leaveConfigMap.item.*`). Only
 * the CHOSEN record is rendered — one table at a time, as today — and each record's picker form carries
 * a hidden `record` so Show stays on its sub-tab.
 *
 * EVERY OLD ADDRESS KEEPS WORKING: `records/entitlement` and `records/balances` are redirect stubs to
 * the right sub-tab with `?capture=` kept; the two older stubs under /admin/leave/entitlements point
 * straight here (one hop, not two); both CSV route handlers are untouched, so every saved download link
 * still downloads. No archive row is read differently, written, or deleted by anything on this page.
 *
 * READ-ONLY BY CONSTRUCTION: no server action, no mutating form. SERVER COMPONENT: plain links, and
 * only serialisable props cross into the two record components (they are server components too).
 */
export default async function LeaveConfigResetRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; capture?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leaveConfigRecords');
  const tNav = await getTranslations('nav');
  const sp = await searchParams;
  const record = leaveConfigRecordOf(sp.record);

  const labels = await Promise.all(
    LEAVE_CONFIG_RECORD_IDS.map(async (id) => [id, await leaveConfigScreenTitle(LEAVE_CONFIG_RECORD_LABEL_ID[id])] as const),
  );
  // The look is the row tab strip's (components/leave-config-map.tsx `LeaveConfigMap`), so the two
  // sub-tabs read as what they are: the two records of one sub-screen, not a second row.
  const tab = (active: boolean) =>
    `flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
      active
        ? 'border-transparent bg-accent font-semibold text-accent-foreground'
        : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground'
    }`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        back={{ href: leaveConfigScreenHref('adjustments'), label: tNav('leaveAdjustments') }}
      />

      <nav aria-label={t('tabsLabel')} data-testid="reset-records-tabs">
        <ol className="flex flex-wrap items-center gap-1.5">
          {labels.map(([id, label], i) => (
            <li key={id} className="flex items-center gap-1.5">
              {i > 0 ? <span aria-hidden className="hidden h-px w-3 bg-border sm:block" /> : null}
              {id === record ? (
                // The current sub-tab is NOT a link: a link to where you already are is a dead control.
                <span aria-current="page" className={tab(true)}>
                  {label}
                </span>
              ) : (
                <Link href={leaveConfigRecordHref(id)} className={tab(false)}>
                  {label}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>

      {record === 'balances' ? (
        <ResetRecordBalances s={s} capture={sp.capture} />
      ) : (
        <ResetRecordConfiguration s={s} capture={sp.capture} />
      )}
    </div>
  );
}

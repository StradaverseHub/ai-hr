import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigScreenHref } from '@/components/leave-config-map';
import {
  EntitlementTablesBlock,
  loadEntitlementTablesData,
} from '../../leave/entitlements/templates/entitlement-tables-block';
import { EligibilityExplainPanel } from '../../leave/entitlements/templates/eligibility-explain';
import { LeaveConfigPreviewNote } from '../preview-note';

/**
 * a6fe37fc ROUND 3 — ENTITLEMENT TABLES at its new address (`/admin/leave-config/entitlement-tables`).
 *
 * ⚠️ IT REPLACES NOTHING YET. `/admin/leave/entitlements/templates` is untouched, still registered and
 * still what the menu links to; the two are live side by side until Round 5 empties the old page and
 * repoints its address here (docs/design/a6fe37fc-migration-order.md, Round 3 / Round 5).
 *
 * ⚠️ THE FLOW IS NOT CHANGING, SO NOTHING IN IT IS RE-IMPLEMENTED. IA §2.0.2 says this screen was
 * rebuilt to an approved shape within the last year and nothing in the reporter's complaint is about it,
 * and IA §2.3 states the rule this page obeys: ONE component, several mount points. Both surfaces below
 * are mounted from the files the old page mounts them from —
 *   · `EntitlementTablesBlock` (F33), UNFILTERED: every leave type side by side, which is the only thing
 *     this screen does that the leave type's own tab 3 cannot;
 *   · `EligibilityExplainPanel` (F49 — see below), the named-employee answer to "no eligibility rule
 *     reaches you".
 * A filtered or re-typed copy of either would be the second implementation this whole item exists to
 * remove.
 *
 * ⚠️ F49 IS A FUNCTION IA §3.2's TABLE NEVER LISTED, AND THIS SCREEN NEARLY LOST IT. The table gives this
 * screen exactly one row (F33, "Entitlement tables + eligibility for all leave types side by side") and
 * says nothing about r212's (`8ebf77ae`) employee explain panel, which is a whole second Card, four GET
 * parameters and the reporter's ORIGINAL ticket for that item. It landed before the design's baseline
 * (`main@0c01befc`), exactly like F47/F48 did on the leave type screen, so a table-keyed anti-drop guard
 * could not see it go. It is carried here and §3.2 now lists it as F49 — the r258 lesson repeated: when a
 * surface is found missing, the DOCUMENT is half the fix.
 *
 * A SAVE MADE HERE LANDS ON THE OLD SCREEN — see `../preview-note.tsx` for why that is deliberate.
 *
 * SERVER COMPONENT, like the page it mirrors: the block's two client islands receive only serialisable
 * props and the explain panel's search is a plain GET form, so nothing new crosses a boundary
 * (test/server-client-boundary.test.ts).
 */
export default async function LeaveConfigEntitlementTablesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    editTemplate?: string;
    editRule?: string;
    /** r212 — the explain panel's four GET parameters, so an answer is addressable and can be sent as a
     *  link. The panel builds its own relative hrefs, so it is addressable at THIS route unchanged. */
    explainQ?: string;
    explainEmployment?: string;
    explainLeaveType?: string;
    explainAsOf?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.entitlementTemplates');
  const sp = await searchParams;
  const data = await loadEntitlementTablesData(s);

  return (
    <div className="space-y-6">
      {/* The SAME heading the old screen renders, deliberately: "same behaviour at a new address" (IA §3)
          means the administrator must not have to learn a second name for one screen. */}
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      {/* The area map — without it a leave-config screen can reach no other leave-config screen at all.
          `current="entitlementTables"` because this IS that screen: the map names screens, not addresses,
          and Round 5 repoints the entry here. */}
      <LeaveConfigMap current="entitlementTables" />
      <LeaveConfigPreviewNote />
      <ErrorBanner message={sp.error} />

      <Card>
        <div className="space-y-2 p-4 text-sm">
          <p className="text-muted-foreground">{t('intro')}</p>
          <p className="text-muted-foreground">{t('coexistNote')}</p>
          <p className="text-muted-foreground">{t('datedNote')}</p>
          {/* r259 — ONE navigation direction inside the preview module, and it is OUT until Round 5. The
              href comes from the SAME map this page renders above, so the back-link and the menu cannot
              give two answers to "where is the leave type screen". It read `/admin/leave-config/types`
              and that was the inconsistent half: the map on this very page walks the administrator to
              `/admin/leave/…`. See components/leave-config-map.tsx → leaveConfigScreenHref. */}
          <Link href={leaveConfigScreenHref('leaveTypes')} className="inline-block text-sm underline">
            {t('backToEntitlements')}
          </Link>
        </div>
      </Card>

      {/* F33 — unfiltered: no `leaveTypeId`, so the Leave type column stays and the create form keeps its
          type picker. Byte-for-byte the mount the old page makes. */}
      <EntitlementTablesBlock data={data} editTemplate={sp.editTemplate} editRule={sp.editRule} />

      {/* F49 (r212 8ebf77ae) — the question the tables above cannot answer for one person: which rules
          exist, which are in force, and what about THIS employee does not match. Below the rules it
          explains, because it is read after them. */}
      <EligibilityExplainPanel s={s} data={data} params={sp} />
    </div>
  );
}

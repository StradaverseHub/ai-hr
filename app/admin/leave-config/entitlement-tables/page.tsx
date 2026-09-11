import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import {
  EntitlementTablesBlock,
  loadEntitlementTablesData,
} from '../../leave/entitlements/templates/entitlement-tables-block';
import { EligibilityExplainPanel } from '../../leave/entitlements/templates/eligibility-explain';

/**
 * a6fe37fc — ENTITLEMENT TABLES (`/admin/leave-config/entitlement-tables`).
 *
 * ⚠️ ROUND 5 (cutover) HAS HAPPENED: this IS the screen. `/admin/leave/entitlements/templates` is an
 * unguarded redirect stub pointing here, it has left lib/permissions.ts's leaveConfig `routes`, the map's
 * `entitlementTables` entry names this address, and `ENTITLEMENT_TEMPLATES` (app/admin/_redirects.ts) —
 * the target every table and eligibility save returns to — names it too. The stub is never deleted.
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
 * THE HEADING IS THE MENU'S OWN STRING (`leaveConfigScreenTitle('entitlementTables')`), so the name in
 * the menu and the name on the page cannot drift — the defect IA §1.1 measured. It renders the same words
 * the old page's private `admin.entitlementTemplates.pageTitle` did, so nobody has to learn a second name;
 * the namespace stays, because the block, the bands editor and the explain panel all read the rest of it.
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
  // 6aee1d91 — the SAME explainer the leave type's tab 3 renders, read from the same key, so the two mounts
  // of the tables block cannot describe eligibility and entitlement two ways.
  const tTypes = await getTranslations('admin.leaveConfigTypes');
  const sp = await searchParams;
  const data = await loadEntitlementTablesData(s);
  // 10b59703 — this is a TAB of Entitlements: the heading and the description are the row's, and the
  // tab row below says which tab. The back-link to the leave type screen is gone with it — the first tab
  // of the same row is one click away and the submenu row stays lit here (ownedSubpaths).
  const header = await leaveConfigPageHeader('entitlementTables');

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      {/* `current="entitlementTables"` because this IS that tab of the Entitlements row. */}
      <LeaveConfigMap current="entitlementTables" />
      <ErrorBanner message={sp.error} />

      <Card>
        <div className="space-y-2 p-4 text-sm">
          {/* The tab's own one-liner leads its content, now that the header carries the row's. */}
          <p className="font-medium text-foreground">{t('pageDescription')}</p>
          <p className="text-muted-foreground">{t('intro')}</p>
          <p className="text-muted-foreground">{t('coexistNote')}</p>
          <p className="text-muted-foreground">{t('datedNote')}</p>
        </div>
      </Card>

      {/* 6aee1d91 — eligibility (tab 2 of the leave type) versus entitlement (the schemes below), in the
          approved words, at the top of the unscoped block. */}
      <p
        role="note"
        data-testid="scheme-explainer"
        className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground"
      >
        {tTypes('entitlementStep.schemeExplainer')}
      </p>

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

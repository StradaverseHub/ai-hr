import { getTranslations } from 'next-intl/server';

import Link from 'next/link';

import { requireAdmin } from '@/lib/authz';
// 3a4efe9f — the same resolver the block scopes itself with, so this page's caption and the table under it
// cannot disagree about whether a filter is in force.
import { resolveViewLeaveTypeId } from '@/lib/entitlement-tables-scope';
import { Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import {
  EntitlementTablesBlock,
  loadEntitlementTablesData,
} from '../../leave/entitlements/templates/entitlement-tables-block';
import { EligibilityExplainPanel } from '../../leave/entitlements/templates/eligibility-explain';
// 9e2a89e9 — "every employee no entitlement table reaches", mounted HERE and nowhere else: the reader
// sweeps every active employment, and the leave type panels compose the tables block 24 at a time.
import { UncoveredEmployeesCard } from '../../leave/entitlements/templates/uncovered-employees';

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
    /**
     * 3a4efe9f (r369) — THE LEAVE TYPE FILTER, AS A QUERY PARAMETER ON THIS ADDRESS AND NOT A NEW ROUTE.
     *
     * A second address would break four exact-set navigation guards: `test/leave-config-map.test.ts` pins
     * the Entitlements row as exactly `['leaveTypes', 'entitlementTables']` in that order,
     * `test/leave-flyout-nav.test.ts` pins that row at exactly two items with `ownedSubpaths` of exactly
     * `['/admin/leave-config/entitlement-tables']`, and `test/r266-leave-config-rows.test.ts` pins the
     * flattened href list and its count. A filter is a view of this screen, not another screen, so it
     * belongs in the query string — which is also what makes it linkable from the leave type screen.
     *
     * Absent or naming no live leave type ⇒ every leave type side by side, which is this screen's default
     * and the one thing it does that a leave type's own tab 3 cannot.
     */
    leaveType?: string;
    /** 3a4efe9f — the table a deep link came here to show: highlighted by the block, and scrolled to by the
     *  same link's `#table-<lineageId>` fragment, which needs no JavaScript. */
    table?: string;
    /**
     * 3a4efe9f — the leave type to put the operator back on after a save, set by "+ New table" on that leave
     * type's own tab (the approved plan's step 2.4). It becomes the `embeddedLeaveTypeId` the create form
     * posts, which `returnFor` in the templates actions already reads. An id, never a URL: `returnFor`'s
     * header records that it is interpolated into a fixed internal path, so nothing hand-crafted can open a
     * redirect through it.
     */
    returnTo?: string;
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
  // r270 (995387c6) — 6aee1d91's scheme explainer, and the `admin.leaveConfigTypes` translator that read
  // it, are GONE FROM THIS SCREEN. It described the difference between the leave type's eligibility and
  // the benefit schemes below it; there are no schemes below it any more, so it explained a section that
  // is not on the page. It is unchanged on the leave type's own tab, which is where the schemes are.
  const sp = await searchParams;
  const data = await loadEntitlementTablesData(s);
  // 10b59703 — this is a TAB of Entitlements: the heading and the description are the row's, and the
  // tab row below says which tab. The back-link to the leave type screen is gone with it — the first tab
  // of the same row is one click away and the submenu row stays lit here (ownedSubpaths).
  const header = await leaveConfigPageHeader('entitlementTables');
  /** The leave type the filter is actually on — resolved through the SAME pure function the block scopes
   *  itself with, so the caption and the table below it cannot disagree about whether a filter applied. An
   *  id naming nothing resolves to undefined here exactly as it does there, and the caption says "all". */
  const filteredTypeName = data.leaveTypes.find(
    (x) => x.id === resolveViewLeaveTypeId({ typeFilter: sp.leaveType, known: data.leaveTypes }),
  )?.name;

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

      {/* ── 3a4efe9f (r369) · THE LEAVE TYPE FILTER ───────────────────────────────────────────────────
          A plain GET form, so this stays a server component and the filter is a URL the operator can send.
          Submitting drops `?table=` and `?editTemplate=` on purpose: both name a record inside whatever
          was on screen before, and carrying them across a change of filter would highlight or open a table
          the new filter does not show.

          ⚠️ THIS IS NOT THE HARDCODED FILTER RETURNING. The default — "All leave types", the empty value —
          is this screen's every-type view, unchanged, and it is what an operator who never touches the
          control sees. What the filter buys is a screen that KNOWS which leave type it is about, which is
          the only condition under which the create form's reach warning can be worded at all. */}
      <Card>
        <form className="flex flex-wrap items-end gap-3 p-4" method="get">
          <Field label={t('filterLeaveType')}>
            <select className={inputCls} name="leaveType" defaultValue={sp.leaveType ?? ''}>
              {/* An EMPTY value clears the filter — the same "no choice is a real instruction" shape the
                  default-table picker uses, so the way out of a filter is the way into it. */}
              <option value="">{t('filterAllTypes')}</option>
              {data.leaveTypes
                .filter((x) => !x.archived)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </Field>
          <button
            type="submit"
            className="h-9 rounded-md border border-input bg-card px-4 text-sm font-medium"
          >
            {t('filterApply')}
          </button>
          {/* The approved sketch puts "+ New entitlement table" at the top right of this tab, opposite the
              filter. The create form itself has not moved — it is still at the foot of the list, where every
              guard over this block expects it — so this is a jump to it rather than a second form. One
              definition, two ways in. */}
          <Link
            href="#new-entitlement-table"
            className="ml-auto h-9 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {t('newTableJump')}
          </Link>
          {/* ⚠️ THE LINE HAS TO FOLLOW THE FILTER, because it states what is on screen. A fixed sentence
              reading "Showing all leave types side by side" over a filtered list would be a caption that
              contradicts the table under it — and the sentence's job is to tell an operator who narrowed the
              screen how to widen it again. */}
          <p className="basis-full text-xs text-muted-foreground">
            {filteredTypeName ? t('filterHintScoped', { type: filteredTypeName }) : t('filterHint')}
          </p>
        </form>
      </Card>

      {/* F33 — unfiltered BY DEFAULT: no `leaveTypeId`, so with no filter chosen the Leave type column stays
          and the create form keeps its type picker.

          r270 — and two surfaces of the block are switched OFF here, both because this screen was drawing
          a second copy of something that already has one home:
            · `showConfigHealth={false}` (5527ce8f) — Leave balance health is the first thing on the Leave
              types tab, drawn there at page level; this tab drew the identical card above the tables.
            · `showBenefitSchemes={false}` (995387c6) — the schemes list and its create/edit form live on
              the leave type's own "What they are entitled to" tab, and did before this item was raised.
          No prop here names `leaveTypeId`, and two guards read the mount text to prove it. 3a4efe9f — that
          property is unchanged and the claim behind it is now stated exactly: this mount carries NO
          HARDCODED leave type, and with no query parameter it renders every leave type side by side. What
          `typeFilter` adds is the operator's own choice, read from the URL and cleared from the URL. */}
      <EntitlementTablesBlock data={data} typeFilter={sp.leaveType} highlightTable={sp.table} returnToType={sp.returnTo} editTemplate={sp.editTemplate} editRule={sp.editRule} showConfigHealth={false} showBenefitSchemes={false} />

      {/* F49 (r212 8ebf77ae) — the question the tables above cannot answer for one person: which rules
          exist, which are in force, and what about THIS employee does not match. Below the rules it
          explains, because it is read after them. */}
      <EligibilityExplainPanel s={s} data={data} params={sp} />

      {/* 9e2a89e9 — and the same question asked the other way round: not "why this one person", but
          "who is left out", which is the one an administrator needs before year end. `data.today` is the
          page's own clock, so this list and every block above it are judged as at the same date.
          (r270 — the sentence used to name the health card that stood above it; that card is drawn on the
          Leave types tab now, so the old wording named a component this page no longer renders.) */}
      <UncoveredEmployeesCard s={s} asOf={data.today} />
    </div>
  );
}

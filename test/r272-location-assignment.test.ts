import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * r272 (0e8cf366) — LOCATION ASSIGNMENT, AND THE THREE THINGS THAT MADE A DEPENDENCY LOOK REAL.
 *
 * The reporter filed a redesign asking us to stop deriving an employee's clocking locations from Company,
 * State, Holiday Calendar and Branch. **Nothing ever did.** `resolveGeofence` (core/attendance.ts:194)
 * joins `employee_clocking_location` to `clocking_location` and nothing else, and `clocking_location` has
 * had no `company_id` since migration 0459. Eight of the eighteen points in that item were already live.
 *
 * What made the derivation look real were three pieces of presentation, and they are what this round
 * removed. Most of the assertions below are `not.toContain` for exactly that reason: the work was taking
 * things away, and a guard that only checked the new card would not notice any of them coming back.
 */

const CARD = 'app/admin/personnel/[employmentId]/page.tsx';
const PICKER = 'components/attendance/location-assignment.tsx';
/**
 * 639bf4a5 rev 2 (r338) — RE-POINTED, NOT LOOSENED. This read the REGISTER
 * (app/admin/work-locations/page.tsx), because that is where a clocking point's row was rendered when
 * r272 shipped. The register is a COMPANY LISTING now — Company | Location | Status | Action, no rows of
 * its own — and every point's row moved verbatim to app/admin/work-locations/clocking-points.tsx, which
 * the location's own View / Edit screens and the unlinked-points screen all render. Every property r272
 * won is asserted below exactly as before, at the file that now holds it; a guard left reading the old
 * file would have gone quietly vacuous the moment the rows moved.
 */
/*
 * r423 (83c0d3c8) — RE-POINTED AGAIN, at Attendance › Locations (app/admin/work-locations/clocking/page.tsx),
 * which is now THE list of clocking locations; clocking-points.tsx was deleted with the rows it rendered
 * under work locations. Two r272 properties are REVERSED there on the reporter's instruction and pinned as
 * reversed below (§C): a location is now opened to named companies and the list prints them.
 */
const ADMIN = 'app/admin/work-locations/clocking/page.tsx';
const read = (p: string) => readFileSync(p, 'utf8');
const card = read(CARD);
const picker = read(PICKER);
const admin = read(ADMIN);
const en = JSON.parse(read('messages/en.json'));
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'];

describe('§A · the pre-tick is gone, and cannot come back quietly', () => {
  it('no branch- or location-derived seed reaches the assignment control', () => {
    // The defect was never that it SAVED — `tab-save-scope` never posts an untouched section. It was that
    // opening an unassigned employee showed sites already ticked, which reads as the system having chosen.
    expect(card, 'the seed variable is gone').not.toContain('preTickLocationId');
    expect(card, 'and so is the filter that built it').not.toMatch(
      /clockingLocations\.filter\(\(cl\) => cl\.locationId === /,
    );
    // What remains is the employee's OWN saved set, and nothing else.
    expect(card).toContain('const clockingDefaultIds = [...assignedClockingLocationIds];');
  });

  it('the sentence that counted points under the employee’s work location is gone too', () => {
    // "N clocking points are linked to this employee's work location" is a sentence ABOUT the coupling,
    // on the card whose complaint is that the coupling appears to exist.
    expect(card).not.toContain('resolvedLocationPointCount');
    expect(card).not.toContain("tc('linkedPoints'");
    expect(card).not.toContain("tc('noAssignedSites'");
  });

  it('the bare multi-select is gone and the card mounts the picker instead', () => {
    expect(card).not.toContain('name="clockingLocationIds"\n                multiple');
    expect(card).not.toContain('h-28');
    expect(card).toContain('<LocationAssignment');
    expect(card, 'the posted field is unchanged — the control moved, the contract did not').toContain(
      'name="clockingLocationIds"',
    );
  });
});

describe('§B · the picker: one selection, two views of it', () => {
  it('Remove and unticking are the same operation, so the table and the picker cannot disagree', () => {
    // Remove is not a separate action against the server. If it ever becomes one, the table and the
    // popover become two opinions about what is going to be saved.
    expect(picker).toContain('const remove = (id: string) =>');
    expect(picker).toContain('next.delete(id)');
    expect(picker, 'the table renders FROM the selection').toContain(
      'locations.filter((l) => selected.has(l.id))',
    );
  });

  it('the form contract is the popover’s, and this component adds no second one', () => {
    // MultiSelectPopover emits one hidden input per selected id, outside its open/closed guard. A second
    // emitter here would post every id twice.
    expect(picker).toContain('<MultiSelectPopover');
    expect((picker.match(/type="hidden"/g) ?? []).length, 'no hidden inputs of its own').toBe(0);
  });

  it('Remove is type="button" — a bare button inside the tab’s form would submit it', () => {
    /**
     * ⚠️ VACUOUS ON ITS FIRST WRITE, caught by the mutation pass — the SECOND time this exact trap has
     * been hit in two rounds. It looked for `type="button"` within 200 characters before the handler, and
     * the comment explaining why that attribute is load-bearing sits directly above it and contains the
     * string. Stripping the real attribute left the test green.
     *
     * Comments are stripped before the check, and the attribute is pinned as ADJACENT to the handler.
     * A window search near an explanation of the thing being searched for measures the explanation.
     */
    const code = picker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'the comment must not be what satisfies this').not.toContain('load-bearing');
    expect(code).toMatch(/type="button"\s+onClick=\{\(\) => remove\(l\.id\)\}/);
  });

  it('NO FUNCTION PROPS cross into this client component — the render check caught this, nothing else did', () => {
    /**
     * The first cut passed `selectedCount: (n) => tc(...)` and `radiusText: (r) => tc(...)` from the
     * server page. tsc was clean, eslint was clean, and all thirteen guards here were green — and the
     * personnel page returned **500** with "Functions cannot be passed directly to Client Components".
     * CLAUDE.md §8 names this exact class: a 200 is not a render check, and a green suite is a claim
     * about the tests. Counts are a template string substituted here; per-row text is formatted server
     * side and passed as a string.
     */
    const labelsBlock = card.slice(card.indexOf('labels={{'), card.indexOf('}}', card.indexOf('labels={{')));
    expect(labelsBlock.length, 'the labels prop must exist').toBeGreaterThan(0);
    expect(labelsBlock, 'no arrow functions in the labels prop').not.toMatch(/=>/);
    expect(card, 'the count is a template, substituted client-side').toContain('selectedCountTemplate:');
    expect(picker).toContain("labels.selectedCountTemplate.replace('{count}'");
    // …and the per-row radius arrives already formatted, per location.
    expect(card).toContain('radiusText: cl.radiusM != null ?');
  });

  it('a site with no radius says so rather than rendering a blank', () => {
    // A site with no radius can never match at clock-in; a blank cell looks like nothing is wrong.
    expect(picker).toContain('l.radiusM == null');
    expect(picker).toContain('labels.noRadius');
  });

  it('the reporter’s columns are the ones rendered — and Timezone is NOT among them', () => {
    for (const c of ['colLocation', 'colAddress', 'colRadius', 'colStatus']) {
      expect(picker, c).toContain(`labels.${c}`);
    }
    // Refused deliberately: there is no timezone column on either table and lib/hr-date.ts hard-wires
    // Asia/Kuala_Lumpur, so a per-site timezone changes how every attendance date is computed.
    expect(picker).not.toMatch(/timezone/i);
  });
});

describe('§C · the company coupling — removed by r272, made REAL and explicit by r423 (r428: summarised, never the linked work location)', () => {
  it('the list derives Shared With from the companies a location is OPEN to, never the company of a linked work location', () => {
    // r272 removed a company name printed on a clocking group heading because a clocking site HAD no
    // company — the name came from an optional linked work `location`, which made the register read as
    // company configuration. r423 (83c0d3c8) gave a location an explicit list of companies allowed to use
    // it; r428 (83c0d3c8 contest) summarises that list as "Shared With" once the screen is scoped to one
    // company (sharedWith(cl.companies), never the linked location's company — the property survives the
    // chip list it used to be spelled out as).
    expect(admin).toContain('sharedWith(cl.companies)');
    expect(admin).not.toContain('locationCompanyName');
    expect(admin).not.toContain('g.companyName');
    // The work location screens keep their own identity header (Work Locations is otherwise unchanged).
    const edit = read('app/admin/work-locations/[id]/edit/page.tsx');
    expect(edit).toContain('`${site.companyName} · ${site.code} · ${site.name}`');
  });

  it('the branch-unmapped sentence stops sending a holiday-calendar problem to the clocking screen', () => {
    const v = en.people.detail.locationBranchUnmapped as string;
    expect(v).not.toMatch(/Clocking location/i);
    expect(v, 'it names where a branch is actually mapped').toMatch(/Locations/);
    // …and says plainly that it is not about clocking, which is the confusion being removed.
    expect(v).toMatch(/Location assignment/);
    for (const loc of LOCALES) {
      const t = JSON.parse(read(`messages/${loc}.json`)).people.detail.locationBranchUnmapped;
      expect(typeof t, loc).toBe('string');
      if (loc !== 'en') expect(t, `${loc} is still English`).not.toBe(v);
    }
  });
});

describe('§D · the list says what state a site is in, and lets a reader open it', () => {
  it('status is stated on every row, not implied by the absence of a badge', () => {
    // r423 — the plan's words: Active / Inactive (the archive stamp underneath is unchanged).
    expect(admin).toContain("cl.archivedAt ? t('statusInactive') : t('statusActive')");
    // The old shape: a badge only when archived. Active was conveyed by nothing at all.
    expect(admin).not.toContain("{cl.archivedAt && (\n        <span className=\"rounded-full bg-muted");
  });

  it('a reader who may not edit still gets a way in', () => {
    // r423 — every row carries View (a read-only page of its own, clocking/[id]); Edit and Deactivate /
    // Activate follow only for a group administrator. The property r272 won — a reader who may not edit
    // can still open a location — is asserted as: View precedes the group-admin gate, outside it.
    // r428 — the hrefs are built once per row (viewHref/editHref, carrying the company this screen was
    // opened from) rather than called inline; the SAME property is asserted against those variables.
    const view = admin.indexOf('href={viewHref}');
    const gate = admin.indexOf('{groupAdmin && (', view);
    expect(view).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(view);
    expect(admin.slice(view, gate)).toContain("t('view')");
    expect(admin.slice(gate)).toContain('href={editHref}');
  });

  it('every string this round minted exists in all six catalogues and is translated', () => {
    const keys = [
      ['people', 'detail', 'clocking', 'assignmentTitle'],
      // r423 retired assignmentIntro and noneAssigned (switchDescription / cannotClockWarning replace them).
      ['people', 'detail', 'clocking', 'switchTitle'],
      ['people', 'detail', 'clocking', 'cannotClockWarning'],
      ['people', 'detail', 'clocking', 'addLocation'],
      ['people', 'detail', 'clocking', 'statusActive'],
      ['people', 'detail', 'clocking', 'noRadius'],
      ['admin', 'locations', 'view'],
    ];
    for (const path of keys) {
      const base = path.reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, en) as unknown as string;
      expect(typeof base, path.join('.')).toBe('string');
      for (const loc of LOCALES) {
        const cat = JSON.parse(read(`messages/${loc}.json`));
        const v = path.reduce<Record<string, unknown>>((n, k) => n?.[k] as Record<string, unknown>, cat) as unknown as string;
        expect(typeof v, `${loc} ${path.join('.')}`).toBe('string');
        expect(String(v).trim(), `${loc} ${path.join('.')} is empty`).not.toBe('');
        if (loc !== 'en') expect(v, `${loc} ${path.join('.')} is still English`).not.toBe(base);
      }
    }
  });
});

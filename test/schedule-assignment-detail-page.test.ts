/**
 * a485afa1 rev 2 (r265) — View / Edit on Schedule Assignment opens a page of its own.
 *
 * The reporter contested r263's inline panel: on a 74-row list it opened at the TOP of the page, so
 * View / Edit on a row near the bottom jumped the browser away from the row and Close put them back at
 * the top. The behaviour — where Save, Cancel, Back and a refusal land — is asserted on the real actions
 * and real renders in test/schedule-assignment.test.ts. THIS file is the source-shape half, in the house
 * style of test/schedule-config-screen.test.ts: the promises a later round could quietly undo without any
 * behaviour test noticing, each named so the failure says which promise.
 *
 *   1. THE PANEL IS GONE FROM THE LIST. Not hidden, not renamed: no anchor, no shared control, no Remove,
 *      no history read. The tempting regression is "just show it inline as well" — that is the r263
 *      shape the reporter rejected.
 *   2. r263 LINKS KEEP WORKING. `?assign=<uuid>` on the list REDIRECTS to the new page. Drop that branch
 *      and every bookmark and chat link written between r263 and r265 opens a list with no panel.
 *   3. THE PAGE IS THE SHIFT LIBRARY'S EDIT-PAGE SHAPE (app/admin/attendance/[shiftId] + shift-form.tsx):
 *      a header with a back link, Save beside a Cancel LINK (never a second form), the hidden returnTo,
 *      and the three blocks in the reporter's order.
 *   4. REGISTERED IN THE SAME COMMIT. test/function-access.test.ts fails generically in both directions;
 *      this names the route so the failure names the screen.
 *   5. THE WORDS. The page is headed by the string the panel rendered and the personnel card renders —
 *      "Shift arrangement", one name for one record at both doors — and the list's description no longer
 *      promises that View / Edit opens "here, on this screen", in any of the six locales. i18n-check.mjs
 *      proves a key exists everywhere; it cannot see that a locale was left saying the old thing.
 *
 * Static over source for the pages (requireAdmin() resolves a real session the harness cannot mint —
 * test/attendance-menu-relocation.test.ts). No DB.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REGISTERED_ROUTES } from '../lib/permissions';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const LIST = 'app/admin/attendance/schedule-assignment/page.tsx';
const DETAIL = 'app/admin/attendance/schedule-assignment/[employmentId]/page.tsx';
const ACTIONS = 'app/admin/attendance/schedule-assignment/actions.ts';
const ROUTE = '/admin/attendance/schedule-assignment/[employmentId]';
const LIST_ROUTE = '/admin/attendance/schedule-assignment';

/** The index of `needle` in `src`, asserted PRESENT first — `indexOf` returns -1 for an absent needle,
 *  and -1 is less than every other index, so a bare `toBeLessThan` passes when the thing is missing. */
const at = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `${JSON.stringify(needle)} is in the source`).toBeGreaterThan(-1);
  return i;
};

/** CODE only — the pages' headers deliberately QUOTE what they replaced. */
const withoutComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

describe('a485afa1 rev 2 — the list is a list again', () => {
  const list = read(LIST);
  const code = withoutComments(list);

  it('renders no panel: no anchor, no shared control, no Remove, no history', () => {
    expect(code, 'the r263 panel anchor is gone').not.toContain('assign-panel');
    expect(code, 'the list does not mount the three fields').not.toContain('EmployeeShiftFields');
    expect(code, 'the list offers no Remove').not.toContain('ConfirmSubmit');
    expect(code, 'the history is read by the detail page, not the list').not.toContain('shiftArrangementHistory');
    for (const field of ['shiftType', 'shiftId', 'effectiveFrom']) {
      expect(code, `the list re-declares the ${field} control`).not.toContain(`name="${field}"`);
    }
    expect(code, 'nothing is posted from the list').not.toContain('<form');
    // A removal stays on the detail page (r265), so nothing lands on the list with `removed=` and the
    // list carries no note for it — a note nothing can trigger is a promise nothing keeps.
    expect(code, 'the list reads no removed= and renders no removedNote').not.toContain('removed');
  });

  it('View / Edit is a link to the row’s own page, and every row is an anchor the way back lands on', () => {
    expect(code).toContain('hrefWith(`${PAGE}/${employmentId}`, {})');
    expect(code).toContain('id={`row-${r.employmentId}`}');
    // The highlight follows `?focus=`, which is what the detail page's Save / Cancel / Back carry.
    expect(code).toContain("r.employmentId === focus ? 'bg-muted/50'");
    expect(code, 'the r263 panel parameter no longer drives a highlight').not.toContain('=== assign');
  });

  it('?assign=<uuid> — a link written before r265 — redirects to the new page instead of rendering', () => {
    expect(code, 'the list imports redirect for exactly this').toContain("import { redirect } from 'next/navigation'");
    expect(code, 'shape-checked, then redirected, before any read').toMatch(
      /if \(assign && UUID_RE\.test\(assign\)\) redirect\(editHref\(assign\)\)/,
    );
    // …and it happens BEFORE the list's reads, so a redirect costs no query. Both indexes are asserted
    // present first: with the redirect deleted, indexOf gives -1 and a bare less-than would still pass.
    expect(at(code, 'redirect(editHref(assign))')).toBeLessThan(at(code, 'listShiftArrangements(s,'));
  });
});

describe('a485afa1 rev 2 — the page of its own', () => {
  const detail = read(DETAIL);
  const code = withoutComments(detail);
  const actions = read(ACTIONS);

  it('exists, guards itself, and is registered on the same column as the list', () => {
    expect(existsSync(path.join(root, DETAIL))).toBe(true);
    // Literally in the file — test/function-access.test.ts detects the guard by regex over the source.
    expect(detail).toContain('requireAdmin()');
    expect(REGISTERED_ROUTES.has(ROUTE), `${ROUTE} is not registered in lib/permissions.ts`).toBe(true);
    expect(REGISTERED_ROUTES.has(LIST_ROUTE)).toBe(true);
    // No nav row: the page is reached from the list, as a shift's edit page is reached from the library.
    expect(read('packs/attendance/index.ts')).not.toContain(`'${ROUTE}'`);
  });

  it('is the shift library’s edit-page shape: back link, Save beside a Cancel LINK, hidden returnTo', () => {
    expect(code, 'headed by the page title, with the way back in the header').toMatch(
      /<PageHeader[\s\S]*?title=\{t\('detailTitle'\)\}[\s\S]*?back=\{\{ href: listHref, label: t\('detailBack'\) \}\}/,
    );
    expect(code, 'name · employee ID · company under the heading').toContain(
      "description={[row.name, row.employeeCode ?? '—', row.company].join(' · ')}",
    );
    expect(code, 'Save posts the adapter').toContain('action={saveScheduleAssignmentAction}');
    expect(code, 'Cancel is a LINK to the list — it posts nothing').toMatch(
      /<Link href=\{listHref\}[^>]*>\s*\{t\('detailCancel'\)\}/,
    );
    expect(code, 'the form tells the action where this page is').toContain('<input type="hidden" name="returnTo" value={returnTo} />');
    expect(code, 'the way back lands on the row').toContain('`#row-${row.employmentId}`');
    // The three blocks, in the reporter's order: in force today, change it, history.
    expect(at(code, "t('summaryTitle')")).toBeLessThan(at(code, "t('changeTitle')"));
    expect(at(code, "t('changeTitle')")).toBeLessThan(at(code, "t('historyTitle')"));
    // The reason a save was refused sits immediately above the fields — inside the change card, after
    // its heading and before the form — not under the page header two cards away.
    expect(at(code, '<ErrorBanner message={sp.error} />')).toBeGreaterThan(at(code, "t('changeTitle')"));
    expect(at(code, '<ErrorBanner message={sp.error} />')).toBeLessThan(at(code, 'action={saveScheduleAssignmentAction}'));
    expect(code.match(/<ErrorBanner /g)?.length, 'one banner, in that one place').toBe(1);
    // …and the form's defaults are what was TYPED when a refusal echoed it, else what is on file.
    expect(code).toContain('defaultType={typedType ?? row.shiftType}');
    expect(code).toContain('defaultShiftId={typedShiftId ?? row.shiftId}');
    expect(code).toContain('defaultEffectiveFrom={typedEffectiveFrom ?? today}');
    // The shared control and the shared chip — no fork of either.
    expect(code).toContain('<EmployeeShiftFields');
    expect(code).toContain('<StatusChip');
    expect(code, 'Remove, confirmed, on the newest row only').toMatch(/i === 0 && history\.length > 1 \?[\s\S]*?<ConfirmSubmit/);
  });

  it('a bad segment is shape-checked before any query and renders the sentence, never notFound()', () => {
    expect(code).toContain('const employmentId = UUID_RE.test(rawId) ? rawId : undefined;');
    expect(at(code, 'UUID_RE.test(rawId)')).toBeLessThan(at(code, 'listShiftArrangements(s,'));
    // The echoed typed values are untrusted url values too: each shape-checked, none reaches a query.
    expect(code).toContain("sp.typedShiftType === 'fixed' || sp.typedShiftType === 'roster'");
    expect(code).toContain('UUID_RE.test(sp.typedShiftId)');
    expect(code).toContain('ISO_DATE_RE.test(sp.typedEffectiveFrom)');
    expect(code).toContain("t('panelMissing')");
    expect(code).not.toContain('notFound(');
  });

  it('the actions send a success to the LIST and every refusal back to the PAGE', () => {
    const code = withoutComments(actions);
    // Each action's OWN body — a string that both actions contain would pass for the wrong one (the
    // verifier's finding: the save refusal was briefly sent to the list and this pin stayed green).
    const saveAt = at(code, 'export async function saveScheduleAssignmentAction');
    const removeAt = at(code, 'export async function removeScheduleArrangementAction');
    expect(removeAt).toBeGreaterThan(saveAt);
    const save = code.slice(saveAt, removeAt);
    const remove = code.slice(removeAt);
    const REFUSAL_TO_PAGE = /\{ list: false, employmentId \},\s*\{\s*error: await messageFor\(e\)/;

    expect(save, 'save success → list, landed on the row').toContain("{ list: true, employmentId }, { saved: '1' }");
    expect(save, 'save refusal → the page, reason beside the fields').toMatch(REFUSAL_TO_PAGE);
    expect(save, 'a refusal of a real id never goes to the list').not.toMatch(/\{ list: true, employmentId \},\s*\{\s*error/);
    // …and it echoes what was typed, under keys that cannot collide with the list's filters.
    expect(save).toContain('typedShiftType: shiftType');
    expect(save).toContain('typedShiftId: rawShift');
    expect(save).toContain('typedEffectiveFrom: rawEffective');

    expect(remove, 'remove success → stays on the page').toContain("{ list: false, employmentId }, { removed: '1' }");
    expect(remove, 'remove refusal → the page').toMatch(REFUSAL_TO_PAGE);
    expect(remove, 'a removal never lands on the list').not.toContain('{ list: true, employmentId }');
    // returnTo is trusted for its QUERY only, and only on this list's two paths.
    expect(code).toContain('DETAIL_RE.test(raw)');
    expect(code, 'the pathname is never taken from the posted field').not.toMatch(/redirect\(\s*raw/);
    // r329 (8cd601d0) added the FIFTH filter, `scheduleGroupId`. The guard is an EXACT SET on purpose and
    // stays one: a filter the list honours but this whitelist drops is a filter that silently resets on
    // every save, which is the r263 complaint in miniature. Widened deliberately, not loosened.
    expect(code, 'exactly the list’s filters ride from one screen to the other').toContain(
      "const FILTER_KEYS = ['q', 'shiftType', 'shiftId', 'status', 'scheduleGroupId'] as const;",
    );
  });
});

describe('a485afa1 rev 2 — the words, in every locale', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  type Catalog = {
    nav: Record<string, string>;
    people: { detail: Record<string, string> };
    admin: { scheduleAssignment: Record<string, string> };
  };
  const cat = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Catalog;
  const NEW_KEYS = ['detailTitle', 'detailBack', 'detailCancel', 'summaryTitle', 'changeTitle'] as const;
  /** How each locale's list description promised the r263 panel. None may survive. */
  const OLD_PROMISE: Record<(typeof LOCALES)[number], string> = {
    en: 'here, on this screen',
    ms: 'di sini, pada skrin ini',
    zh: '就在本页面',
    ta: 'இதே திரையில்',
    th: 'ที่หน้านี้',
    vi: 'ngay trên màn hình này',
  };

  it('the page is headed by the words the personnel card uses — one name for one record at both doors', () => {
    // "A key is not a screen": the plan named the page by the string the panel RENDERED, which is the
    // string the personnel card's SectionHeader renders (people.detail.shiftTypeTitle). Two doors, one
    // name, in every language.
    for (const loc of LOCALES) {
      const c = cat(loc);
      expect(c.admin.scheduleAssignment.detailTitle, `${loc}: detailTitle`).toBe(c.people.detail.shiftTypeTitle);
    }
    expect(cat('en').admin.scheduleAssignment.detailTitle).toBe('Shift arrangement');
  });

  it('the back link names the list by the words its menu row and H1 use', () => {
    for (const loc of LOCALES) {
      const c = cat(loc);
      // The list's H1 IS the menu row's label, so "Back to <that>" is the screen the administrator sees.
      expect(c.admin.scheduleAssignment.pageTitle, `${loc}: the list's H1 vs its menu row`).toBe(c.nav.scheduleAssignment);
    }
    expect(cat('en').admin.scheduleAssignment.detailBack).toBe(`Back to ${cat('en').nav.scheduleAssignment}`);
  });

  it('every new key exists, is not blank, and was not left in English outside en', () => {
    const en = cat('en').admin.scheduleAssignment;
    for (const loc of LOCALES) {
      const ns = cat(loc).admin.scheduleAssignment;
      for (const k of NEW_KEYS) {
        expect(typeof ns[k], `${loc}: ${k}`).toBe('string');
        expect(ns[k], `${loc}: ${k} is blank`).not.toBe('');
        if (loc !== 'en') expect(ns[k], `${loc}: ${k} was left in English`).not.toBe(en[k]);
      }
    }
  });

  it('the list description no longer promises the arrangement opens "here, on this screen"', () => {
    for (const loc of LOCALES) {
      const v = cat(loc).admin.scheduleAssignment.pageDescription;
      expect(v, `${loc}: pageDescription still describes the r263 panel`).not.toContain(OLD_PROMISE[loc]);
    }
    expect(cat('en').admin.scheduleAssignment.pageDescription).toContain('on its own page');
  });

  it('the three panel-only keys are retired everywhere, and no code still asks for them', () => {
    for (const loc of LOCALES) {
      const ns = cat(loc).admin.scheduleAssignment;
      for (const k of ['panelTitle', 'panelClose', 'panelCloseAria']) {
        expect(k in ns, `${loc}: ${k} is still in the catalogue`).toBe(false);
      }
    }
    for (const f of [LIST, DETAIL, ACTIONS]) {
      expect(read(f)).not.toMatch(/'panel(Title|Close|CloseAria)'/);
    }
  });

  it('the two comments that still said View / Edit opens the personnel card are corrected', () => {
    // Stale since r263 (the planner's finding): a reader trusting either comment would restore the r209
    // link. Each is pinned by the sentence that was wrong.
    expect(read('packs/attendance/index.ts')).not.toContain('opening the SAME editor as Personnel Management');
    expect(read('lib/permissions.ts')).not.toContain('opening the per-employee card on the personnel profile');
  });
});

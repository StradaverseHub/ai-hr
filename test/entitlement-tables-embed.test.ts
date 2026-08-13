/**
 * ee6b7c69 — EMBED THE ENTITLEMENT TABLES IN THE ENTITLEMENT STEP.
 *
 * THE SITUATION THIS REPLACES. Step 3 of a leave type, Entitlement, contained no entitlement setting: a
 * caption and an "Open Entitlement tables" link to a separate screen. Everything HR came to set — the
 * days, the service ranges, and who receives them — lived over there, across all 24 leave types at once.
 * Production had (7 Aug 2026) zero entitlement templates and zero eligibility rules, so the step was a
 * signpost and the link led to a blank page.
 *
 * WHAT EACH GROUP OF CASES IS FOR:
 *   §1 The two Cards are ONE definition with TWO mount points, not a copy. A copy is the failure mode
 *      that matters here: two create forms writing the same effective-dated lineage would drift the first
 *      time either was touched, and both would still save.
 *   §2 The scoping itself, which is the only part with real behaviour. An eligibility rule carries NO
 *      leave type — it names a template lineage — so "this type's rules" is derived, and a derivation
 *      that quietly resolved to nothing would show an empty Employee Eligibility list over rules that
 *      exist. Tested against `lib/entitlement-tables-scope.ts` directly rather than by rendering: the
 *      block is a server component importing a 'use server' module and cannot be mounted in vitest.
 *   §3 The step no longer offers the link, and the key that labelled it is gone from all six catalogues.
 *      Companion to test/entitlement-header-actions-removal.test.ts. An orphaned key is what the i18n
 *      ratchet exists to prevent; a live key for a control that cannot render is the same debt.
 *   §4 The deep-link anchor. `LeaveTypeWorkspace` seeds its selection from items[0] and only then applies
 *      #type-<id>, so an embedded Edit link without the anchor works on a soft click (the workspace is
 *      not remounted) and lands on the WRONG leave type on a hard reload. That asymmetry is exactly how a
 *      missing anchor ships, so it is pinned on the source.
 *   §5 A save from the embedded form returns to the step it was typed in. Without this the item's central
 *      promise — "without ever leaving the step" — breaks on the first Save, which redirects to the
 *      standalone screen the embed exists to make unnecessary.
 *
 * DB-free source guard for §1/§3/§4/§5 (the repo convention — see entitlement-header-actions-removal and
 * grade-group-entitlement-relocation): composition and copy are asserted statically, behaviour is not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scopeEntitlementTables } from '../lib/entitlement-tables-scope';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const BLOCK = '/app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';
const CORE = '/core/entitlement-template.ts';
const STANDALONE = '/app/admin/leave/entitlements/templates/page.tsx';
const ENTITLEMENTS = '/app/admin/leave/entitlements/page.tsx';
const PANEL = '/components/leave-type-panel.tsx';
const ACTIONS = '/app/admin/leave/entitlements/templates/actions.ts';

/** COMMENTS ARE NOT CODE (the r134 rule). Every removal here explains itself by NAMING what it removed,
 *  and a bare-substring absence check over raw source would report correct code as wrong. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

const blockSrc = read(BLOCK);
const coreCode = stripComments(read(CORE));
const standaloneCode = stripComments(read(STANDALONE));
const entitlementsCode = stripComments(read(ENTITLEMENTS));
const panelCode = stripComments(read(PANEL));
const actionsSrc = read(ACTIONS);

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalogue = (loc: string) => JSON.parse(read(`/messages/${loc}.json`));

describe('§1 ee6b7c69 · one definition of the tables, two mount points', () => {
  it('both hosts mount the shared block and neither re-declares the forms', () => {
    for (const [name, code] of [
      ['the standalone screen', standaloneCode],
      ['the Entitlements page', entitlementsCode],
    ] as const) {
      expect(code, `${name} must render the shared block`).toContain('<EntitlementTablesBlock');
      // The two client forms are the parts that could plausibly be copied — they are the editors.
      expect(code, `${name} must not carry its own bands editor`).not.toContain('<EntitlementBandsEditor');
      expect(code, `${name} must not carry its own rule form`).not.toContain('<EligibilityRuleForm');
    }
    expect(blockSrc).toContain('<EntitlementBandsEditor');
    expect(blockSrc).toContain('<EligibilityRuleForm');
  });

  it('the standalone screen mounts it UNFILTERED and the step mounts it FILTERED', () => {
    // The standalone screen is the "every leave type side by side" view the plan promised would survive,
    // so it must not acquire a leaveTypeId; the step is the item, so it must pass one.
    const standaloneMount = standaloneCode.slice(standaloneCode.indexOf('<EntitlementTablesBlock'));
    expect(standaloneMount.slice(0, standaloneMount.indexOf('/>'))).not.toContain('leaveTypeId');
    expect(entitlementsCode).toContain('leaveTypeId={leaveTypeId}');
  });

  it('the reads happen ONCE per page, not once per panel', () => {
    // The Entitlements page composes a panel for EVERY leave type (they are props of a client workspace,
    // so all of them render). A block that loaded for itself would multiply eleven queries by the number
    // of leave types — 264 on this tenant — for a screen that shows one type's tables.
    expect(entitlementsCode).toContain('await loadEntitlementTablesData(s)');
    expect(entitlementsCode.match(/loadEntitlementTablesData\(/g)).toHaveLength(1);
    expect(standaloneCode.match(/loadEntitlementTablesData\(/g)).toHaveLength(1);
    // …and the per-type node is composed from that ONE bundle.
    expect(entitlementsCode).toContain('data={entitlementTablesData}');
  });
});

describe('§2 ee6b7c69 · the panel shows its own type’s tables, and its own type’s rules', () => {
  const templates = [
    { lineageId: 'lin-annual-a', leaveTypeId: 'annual', name: 'Annual standard' },
    { lineageId: 'lin-annual-a', leaveTypeId: 'annual', name: 'Annual standard v2' },
    { lineageId: 'lin-annual-b', leaveTypeId: 'annual', name: 'Annual executive' },
    { lineageId: 'lin-sick-a', leaveTypeId: 'sick', name: 'Sick standard' },
  ];
  const rules = [
    { templateLineageId: 'lin-annual-a', name: 'Everyone · annual' },
    { templateLineageId: 'lin-annual-b', name: 'Executives · annual' },
    { templateLineageId: 'lin-sick-a', name: 'Everyone · sick' },
    { templateLineageId: 'lin-orphan', name: 'Points at nothing' },
  ];
  const all = { templates, rules };

  it('templates are filtered on the leave type, EVERY version of them', () => {
    const scoped = scopeEntitlementTables(all, 'annual');
    expect(scoped.templates.map((x) => x.name)).toEqual([
      'Annual standard',
      'Annual standard v2',
      'Annual executive',
    ]);
    // The superseded version is deliberately kept: a closed year was reported against it and the three
    // past-date readers still resolve it. Dropping it here would be a different screen, not a filter.
    expect(scoped.templates).toHaveLength(3);
  });

  it('rules are filtered through the template they point at, because a rule has NO leave type', () => {
    const scoped = scopeEntitlementTables(all, 'annual');
    expect(scoped.rules.map((x) => x.name)).toEqual(['Everyone · annual', 'Executives · annual']);
    // Sick's rule is not annual's, and a rule pointing at a lineage that does not exist belongs to no
    // type — it must not leak into the first panel that happens to render.
    expect(scoped.rules.map((x) => x.name)).not.toContain('Everyone · sick');
    expect(scoped.rules.map((x) => x.name)).not.toContain('Points at nothing');
  });

  it('a type with no tables of its own gets an EMPTY list, not everybody else’s', () => {
    // The state production is actually in today: 24 leave types, zero templates. The failure this guards
    // is the opposite of a missing filter — a filter that silently falls back to "show everything".
    const scoped = scopeEntitlementTables(all, 'unpaid');
    expect(scoped.templates).toEqual([]);
    expect(scoped.rules).toEqual([]);
  });

  it('no leaveTypeId ⇒ everything, untouched — the standalone screen', () => {
    const scoped = scopeEntitlementTables(all, undefined);
    expect(scoped.templates).toHaveLength(4);
    expect(scoped.rules).toHaveLength(4);
  });
});

describe('§3 ee6b7c69 · the Open Entitlement tables link is gone from the step', () => {
  it('the step renders the tables themselves, not a pointer at another screen', () => {
    expect(entitlementsCode).toContain('entitlementTablesSection');
    expect(panelCode).toContain('{entitlementTablesSection}');
    // The old slot name and the link it wrapped.
    expect(entitlementsCode).not.toContain('entitlementTablesLink');
    expect(panelCode).not.toContain('entitlementTablesLink');
    expect(entitlementsCode).not.toContain("entitlementStep.tablesOpen");
  });

  it('the standalone screen is STILL reachable from the page header — the plan promised it survives', () => {
    // Stated positively so a follow-up cleanup that removes the last route to it fails here. It is the
    // only place all 24 leave types' tables can be read side by side.
    expect(entitlementsCode).toContain('href="/admin/leave/entitlements/templates"');
  });

  it('`tablesOpen` is retired from ALL SIX catalogues, and `tablesHint` still exists', () => {
    for (const loc of LOCALES) {
      const step = catalogue(loc).admin.leave.entitlementStep;
      expect(step.tablesOpen, `${loc}: the orphaned link label must go`).toBeUndefined();
      expect(typeof step.tablesHint, `${loc}: the caption is repointed, not removed`).toBe('string');
      // …and repointed: the caption sits ABOVE the tables now, so it must not still send anyone to a screen.
      expect(step.tablesHint).not.toContain('Entitlement Tables screen');
    }
  });

  it('the new per-type heading exists in all six locales and carries its {type} placeholder', () => {
    for (const loc of LOCALES) {
      const v = catalogue(loc).admin.entitlementTemplates.templatesTitleForType;
      expect(typeof v, `${loc}: templatesTitleForType missing`).toBe('string');
      // An ICU contract: the block calls it WITH a value, so a copy that lost the placeholder would render
      // a heading naming no type at all, silently and behind a 200.
      expect(v, `${loc}: must interpolate the leave type`).toContain('{type}');
    }
  });

  it('typesHelp no longer directs the reader to a separate Entitlement tables screen', () => {
    // The last sentence of the help text under the leave type list. It survived release three unchanged
    // and would have contradicted the screen the moment the tables moved into the step.
    expect(catalogue('en').admin.leave.typesHelp).toContain('<strong>Entitlement</strong> step');
    expect(catalogue('en').admin.leave.typesHelp).not.toContain('on <strong>Entitlement tables</strong>');
  });
});

describe('§4 ee6b7c69 · embedded links carry the #type deep-link anchor', () => {
  it('every Edit / Cancel href goes through the anchor helper when the block is scoped', () => {
    // LeaveTypeWorkspace seeds `selected` from items[0] and only then applies #type-<id>. A hard reload of
    // /admin/leave/entitlements?editTemplate=… without the anchor lands on the first leave type
    // alphabetically while the edit form below shows another type's table. Soft navigation survives
    // without it, which is precisely why this needs pinning rather than trusting.
    expect(blockSrc).toMatch(/const href = \(query: string\) =>\s*\(scoped \? `\$\{query\}#type-\$\{leaveTypeId\}` : query\)/);
    const hrefs = blockSrc.match(/href=\{[^}]*\}/g) ?? [];
    const paramHrefs = hrefs.filter((h) => h.includes('editTemplate=') || h.includes('editRule=') || h === "href={href('?')}");
    expect(paramHrefs.length, 'the two Edit links and the two Cancel links').toBe(4);
    for (const h of paramHrefs) expect(h, `${h} must go through href()`).toContain('href(');
  });

  it('and the search params survive on BOTH hosts — edit state is a URL, not client state', () => {
    for (const [name, code] of [
      ['the standalone screen', standaloneCode],
      ['the Entitlements page', entitlementsCode],
    ] as const) {
      expect(code, `${name} must read editTemplate`).toContain('editTemplate');
      expect(code, `${name} must read editRule`).toContain('editRule');
    }
  });
});

describe('§5 ee6b7c69 · a save from the embedded form returns to the step it was typed in', () => {
  it('the embedded mount posts the leave type it is standing in, and only the embedded one', () => {
    expect(blockSrc).toContain("name=\"embeddedLeaveTypeId\"");
    // Guarded by `scoped`: the standalone screen must NOT post it, or every save there would redirect
    // into a leave type panel the operator never opened.
    expect(blockSrc).toMatch(/const returnField = scoped \? <input type="hidden" name="embeddedLeaveTypeId"/);
  });

  it('all six writes honour it, so none of them can bounce HR onto the standalone screen', () => {
    // Named individually rather than counted: a new action added without the return would be exactly the
    // regression this catches, and a count silently absorbs it.
    for (const action of [
      'createEntitlementTemplateAction',
      'updateEntitlementTemplateAction',
      'retireEntitlementTemplateAction',
      'createEligibilityRuleAction',
      'updateEligibilityRuleAction',
      'retireEligibilityRuleAction',
    ]) {
      const start = actionsSrc.indexOf(`export async function ${action}(`);
      expect(start, `${action} must exist`).toBeGreaterThan(-1);
      const body = actionsSrc.slice(start, actionsSrc.indexOf('\n}', start));
      expect(body, `${action} must return through saved()`).toContain('saved(formData,');
      expect(body, `${action} must report failure through refused()`).toContain('refused(formData, e)');
    }
  });

  it('the return is the Entitlements page WITH the type anchor, not the bare route', () => {
    // Same contract as okEntitlements: the anchor rides after the query so ?toast= / ?error= still parse,
    // and an empty id degrades to the bare path rather than emitting a stray '#type-'.
    const redirects = read('/app/admin/_redirects.ts');
    expect(redirects).toContain('export function failEntitlements');
    expect(redirects).toMatch(/failEntitlements[\s\S]*?ENTITLEMENTS\}\?error=[\s\S]*?leaveTypeId \? `#type-\$\{leaveTypeId\}` : ''/);
    expect(actionsSrc).toContain('okEntitlements(msg, embedded)');
    expect(actionsSrc).toContain('failEntitlements(e, embedded)');
  });
});

describe('§6 3214cb11 / 813fd22a · the table and the select cannot drift out of order', () => {
  /**
   * The two items are ONE fix, and this section is why they can stay one. The reporter saw the same
   * scrambled order twice — once in "Entitlement tables for Annual Leave (16)", once in the "Choose an
   * entitlement table" select under New eligibility rule. Both are rendered from ONE page-level read,
   * so ordering was fixed at that read; these cases pin the "one read" part, because the moment either
   * surface acquires a sort of its own the two screens start disagreeing and nobody notices until a
   * screenshot arrives. Source-shape assertions across both files — the defect would live in the
   * CONTRACT between them, where a unit test of either half passes throughout (the r190 rule).
   */
  it('the ORDER is decided once, at the read, not in the block', () => {
    expect(coreCode, 'listEntitlementTemplates must apply the shared comparator').toContain(
      '.sort(compareEntitlementTables)',
    );
    expect(coreCode).toContain("from '../lib/entitlement-table-order'");
  });

  it('the select is fed from the SAME list the table renders — no second read, no second sort', () => {
    const code = stripComments(blockSrc);
    // One scope call; the table maps `templates`, the options map `running`, and `running` is a FILTER
    // of `templates` — filter preserves order, so both surfaces inherit the read's order unchanged.
    expect(code.match(/scopeEntitlementTables\(/g)).toHaveLength(1);
    expect(code).toContain('const running = templates.filter((x) => x.validTo == null)');
    expect(code).toContain('const templateOptions = running.map(');
    expect(code).toContain('templates={templateOptions}');
    // Exactly ONE read for the page, and it is in the loader — not in the component that renders the
    // two surfaces, which must compose from the bundle it was handed.
    expect(code.match(/listEntitlementTemplates\(/g)).toHaveLength(1);
    const component = code.slice(code.indexOf('export async function EntitlementTablesBlock('));
    expect(component, 'the component must not re-read the templates').not.toContain(
      'listEntitlementTemplates(',
    );
    // …and must not re-sort either surface.
    for (const forbidden of ['templates.sort(', 'running.sort(', 'templateOptions.sort(']) {
      expect(code, `the block must not re-sort: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the scoper preserves the order it is handed — it is a filter, not a re-sort', () => {
    // If this ever became a sort, the two surfaces would still agree with each other but BOTH would
    // disagree with the read, silently reinstating A-to-Z on every screen.
    const templates = [
      { lineageId: 'l1', leaveTypeId: 'annual', name: 'PERMANENT - GRADE H' },
      { lineageId: 'l2', leaveTypeId: 'annual', name: 'CONTRACT - GRADE H' },
      { lineageId: 'l3', leaveTypeId: 'annual', name: 'PART TIMER' },
    ];
    const scoped = scopeEntitlementTables({ templates, rules: [] }, 'annual');
    expect(scoped.templates.map((x) => x.name)).toEqual([
      'PERMANENT - GRADE H',
      'CONTRACT - GRADE H',
      'PART TIMER',
    ]);
  });
});

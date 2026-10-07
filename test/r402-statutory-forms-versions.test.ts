/**
 * r402 (item f3cf2444) — ONE CARD PER FORM, A VERSION CHOICE, AN IN-APP VIEWER, AND NO BLANK/REGISTER BUTTON.
 *
 * WHAT THE REPORTER ASKED FOR. The Income Tax shelf showed four cards for two forms — Form C.P.8A (EA) and
 * PCB 2(II), each once in English and once in Bahasa Malaysia — and the EA cards carried a "Blank form and
 * field register" control they no longer want. Open Form's first step sat in a narrow box, and Preview
 * opened a separate browser tab.
 *
 * WHAT THIS PINS, and how. The catalog (localization/my/reports.ts) is the one place the shelf, the
 * criteria step and the pickers read, so the cards are asserted off the catalog the shelf groups, and the
 * Version contract is run through the SAME pure helpers the step and the pickers call (criteria.ts). The
 * screens are server components behind `scopedAdmin`, so their wiring is pinned in source with prose
 * stripped — and the one property that must hold across files (the frame shows the preview route with the
 * download's own parameters) is pinned against `viewerQuery`, which both viewer pages and the DOM case in
 * test/r402-statutory-pdf-viewer.dom.test.tsx use.
 *
 * ⚠️ THIS DELIBERATELY REVERSES r220 AND r242 (the blank form and field register on the EA rows), on the
 * reporter's request. The routes and lib/ea-field-register.ts are KEPT as unlinked endpoints.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MY_STATUTORY_LINKS } from '../localization/my/reports';
import { REGISTERED_ROUTES } from '../lib/permissions';
import {
  TEMPLATED,
  criteriaHref,
  defaultVersion,
  formerIdRedirect,
  parseDestination,
} from '../app/payroll/statutory-forms/criteria';
import { viewerQuery } from '../app/payroll/statutory-forms/viewer-params';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const ROOT = path.resolve(__dirname, '..');
/** Source with prose removed: these files explain at length what they no longer do. */
const code = (p: string) =>
  fs
    .readFileSync(path.join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const OPEN = code('app/payroll/statutory-forms/open/page.tsx');
const EA_PAGE = code('app/payroll/statutory-forms/ea/page.tsx');
const PCB_PAGE = code('app/payroll/statutory-forms/pcb2ii/page.tsx');
const EA_VIEW = code('app/payroll/statutory-forms/ea/view/page.tsx');
const PCB_VIEW = code('app/payroll/statutory-forms/pcb2ii/view/page.tsx');
const PICKER = code('app/payroll/statutory-forms/ea/employee-picker.tsx');
const SHELF = code('app/payroll/statutory-forms/page.tsx');

const LOCALES = { en, ms, ta, th, vi, zh } as const;
const ns = (d: unknown) => (d as { payroll: { statutoryForms: Record<string, string> } }).payroll.statutoryForms;

describe('r402 · one EA card and one PCB 2(II) card on the Income Tax shelf', () => {
  const lhdn = MY_STATUTORY_LINKS.filter((l) => l.body === 'lhdn');

  it('the shelf has ONE C.P.8A (EA) entry and ONE PCB 2(II) entry, at the old first positions', () => {
    const ea = lhdn.filter((l) => l.href.startsWith('/payroll/statutory-forms/ea?'));
    const pcb = lhdn.filter((l) => l.href.startsWith('/payroll/statutory-forms/pcb2ii?'));
    expect(ea.map((l) => l.id)).toEqual(['my.ea']);
    expect(pcb.map((l) => l.id)).toEqual(['my.pcb2ii']);
    expect(ea[0].shelfOrder).toBe(3);
    expect(pcb[0].shelfOrder).toBe(5);
    // No per-language entry survives anywhere in the catalog.
    expect(MY_STATUTORY_LINKS.filter((l) => /\.(en|ms)$/.test(l.id)).map((l) => l.id)).toEqual([]);
    // Each card's name is the form's, with no language in it.
    expect(ns(en)[ea[0].labelKey]).toBe('Form C.P.8A (EA)');
    expect(ns(en)[pcb[0].labelKey]).toBe('PCB 2(II)');
    // …and still one Open Form, going to the criteria step.
    for (const l of [...ea, ...pcb]) {
      expect(l.actionLabelKey).toBe('openForm');
      expect(TEMPLATED.test(l.href), l.id).toBe(true);
    }
    expect(SHELF).toContain('TEMPLATED.test(l.href) ? criteriaHref(l.id) : l.href');
  });

  it('the merged EA card renders no blank-form or field-register control', () => {
    const ea = MY_STATUTORY_LINKS.find((l) => l.id === 'my.ea')!;
    expect([ea.secondaryHref, ea.tertiaryHref, ea.extrasLabelKey]).toEqual([undefined, undefined, undefined]);
    // The card's extras are built from the entry's own fields; with none declared it renders one action.
    expect(SHELF).toContain('extraAction(l.secondaryHref, l.secondaryLabelKey');
    expect(SHELF).not.toContain('/payroll/ea/blank');
    expect(SHELF).not.toContain('/payroll/ea/field-register');
  });

  it('the fidelity is unchanged by the merge', () => {
    for (const id of ['my.ea', 'my.pcb2ii']) {
      expect(MY_STATUTORY_LINKS.find((l) => l.id === id)!.fidelity, id).toBe('agency-layout');
    }
  });
});

describe('r402 · the Version criterion', () => {
  it('the step asks for company, year and version, and the version field is the destination’s `lang`', () => {
    for (const id of ['my.ea', 'my.pcb2ii']) {
      const d = parseDestination(MY_STATUTORY_LINKS.find((l) => l.id === id)!.href);
      expect(d.criteria, id).toEqual([
        { kind: 'company', field: 'companyId' },
        { kind: 'year', field: 'year' },
        { kind: 'version', field: 'lang' },
      ]);
    }
  });

  it('defaults to the first declared version (English), honours a declared one, and ignores anything else', () => {
    const versions = MY_STATUTORY_LINKS.find((l) => l.id === 'my.ea')!.versions;
    expect(defaultVersion(versions, undefined)).toBe('en');
    expect(defaultVersion(versions, 'ms')).toBe('ms');
    expect(defaultVersion(versions, 'en')).toBe('en');
    // A UI locale is not a form version: zh, ta, th and vi fall to English, never to themselves.
    for (const loc of ['zh', 'ta', 'th', 'vi', 'MS', '']) expect(defaultVersion(versions, loc), loc).toBe('en');
    expect(defaultVersion(undefined, 'ms')).toBe('');
  });

  it('the criteria step reads ?lang and draws the entry’s own options, never the viewer’s locale', () => {
    expect(OPEN).toContain('lang?: string');
    expect(OPEN).toContain('defaultVersion(versions, sp.lang)');
    expect(OPEN).toContain("name={field('version')!.field} defaultValue={chosenVersion}");
    expect(OPEN).toContain('versions.map((v) =>');
    // getLocale is still read for MONTH NAMES; it must not feed the version.
    expect(OPEN).not.toMatch(/defaultVersion\([^)]*locale/);
    // Full width now (the reporter's request), and the boxes in one row.
    expect(OPEN).toContain('<div className={pageWideCls}>');
    expect(OPEN).not.toContain('max-w-3xl');
    expect(OPEN).toContain('lg:grid-cols-3');
  });

  it('open?form=my.ea&lang=ms carries lang=ms to the picker, the picker to Preview, and Preview to the PDF', () => {
    // 1 — the step's GET form posts the version under the destination's own name (`lang`) to the picker.
    const d = parseDestination(MY_STATUTORY_LINKS.find((l) => l.id === 'my.ea')!.href);
    expect(d.action).toBe('/payroll/statutory-forms/ea');
    expect(d.criteria.find((c) => c.kind === 'version')!.field).toBe('lang');
    expect(OPEN).toContain('<form method="get" action={parsed.action}');
    // 2 — the picker allowlists it and hands it to the preview/download form as a hidden field, always.
    for (const [name, page] of [['ea', EA_PAGE], ['pcb2ii', PCB_PAGE]] as const) {
      expect(page, name).toContain('defaultVersion(');
      expect(page, name).toContain("{ name: 'lang', value: lang },");
      expect(page, `${name} Preview goes to its viewer`).toContain(`previewAction="/payroll/statutory-forms/${name}/view"`);
      // The entry is found by destination, no longer narrowed by a `lang=` in its href.
      expect(page, name).not.toContain('l.href.includes(`lang=${lang}`)');
    }
    // 3 — the viewer builds the frame from the same parameters, lang included.
    const q = viewerQuery({ companyId: 'c', year: '2025', lang: 'ms', ids: ['11111111-1111-4111-8111-111111111111'] });
    expect(new URLSearchParams(q).get('lang')).toBe('ms');
    for (const [name, view] of [['ea', EA_VIEW], ['pcb2ii', PCB_VIEW]] as const) {
      expect(view, name).toContain(`pdfUrl={\`/payroll/statutory-forms/${name}/preview?\${query}\`}`);
      expect(view, name).toContain(`href: \`/payroll/statutory-forms/${name}/download?\${query}\``);
      expect(view, name).toContain('const query = viewerQuery(params);');
      expect(view, name).toContain('defaultVersion(entry.versions, sp.lang)');
    }
  });
});

describe('r402 · old ids redirect with the right version', () => {
  const CASES = [
    ['my.ea.en', 'my.ea', 'en'],
    ['my.ea.ms', 'my.ea', 'ms'],
    ['my.pcb2ii.en', 'my.pcb2ii', 'en'],
    ['my.pcb2ii.ms', 'my.pcb2ii', 'ms'],
  ] as const;

  it.each(CASES)('%s → %s with lang=%s', (old, merged, lang) => {
    expect(formerIdRedirect(MY_STATUTORY_LINKS, old)).toBe(`${criteriaHref(merged)}&lang=${lang}`);
    expect(formerIdRedirect(MY_STATUTORY_LINKS, old, 'lhdn')).toBe(`${criteriaHref(merged)}&lang=${lang}&body=lhdn`);
  });

  it('a current id and an unknown id do not redirect', () => {
    expect(formerIdRedirect(MY_STATUTORY_LINKS, 'my.ea')).toBeNull();
    expect(formerIdRedirect(MY_STATUTORY_LINKS, 'my.ea.zh')).toBeNull();
    expect(formerIdRedirect(MY_STATUTORY_LINKS, '')).toBeNull();
  });

  it('the step redirects a former id BEFORE it 404s', () => {
    const i = OPEN.indexOf('formerIdRedirect(catalog.links, formId, sp.body)');
    expect(i).toBeGreaterThanOrEqual(0);
    const block = OPEN.slice(i, i + 200);
    expect(block).toContain('if (moved) redirect(moved);');
    expect(block.indexOf('redirect(moved)')).toBeLessThan(block.indexOf('notFound()'));
  });
});

describe('r402 · Preview opens inside the product', () => {
  it('the picker no longer targets a new tab, and comes back with the selection', () => {
    expect(PICKER).not.toContain('formTarget');
    expect(PICKER).toContain('initialSelected');
    for (const page of [EA_PAGE, PCB_PAGE]) {
      // Only ids in this year's population survive the trip back.
      expect(page).toContain('rows.filter((r) => asked.has(r.employmentId))');
      expect(page).toContain('initialSelected={initialSelected}');
    }
  });

  it('both viewer pages check scope before printing a company name, and are registered screens', () => {
    for (const view of [EA_VIEW, PCB_VIEW]) {
      expect(view).toContain('scopedAdmin()');
      expect(view).toContain('scopeIds.includes(sp.companyId)');
      expect(view).toContain('<StatutoryPdfViewer');
    }
    expect(PCB_VIEW, 'PCB 2(II) carries its Selected Date').toContain("name: 'selectedDate'");
    expect(REGISTERED_ROUTES.has('/payroll/statutory-forms/ea/view')).toBe(true);
    expect(REGISTERED_ROUTES.has('/payroll/statutory-forms/pcb2ii/view')).toBe(true);
  });
});

describe('r402 · words in all six locales; old keys retired, never deleted', () => {
  const NEW = [
    'link_ea',
    'link_ea_hint_version',
    'desc_ea',
    'link_pcb2ii',
    'desc_pcb2ii',
    'version',
    'version_hint',
    'version_en',
    'version_ms',
    'viewer_download',
    'viewer_back',
    'viewer_openNewTab',
    'viewer_frameTitle',
    'viewer_showVersion',
  ];
  const RETIRED = [
    'link_ea_en',
    'link_ea_ms',
    'link_pcb2ii_en',
    'link_pcb2ii_ms',
    'link_ea_hint',
    'desc_ea_en',
    'desc_ea_ms',
    'desc_pcb2ii_en',
    'desc_pcb2ii_ms',
    'link_ea_more',
    'link_ea_blank_en',
    'link_ea_blank_ms',
    'link_ea_blank_title',
    'link_ea_register',
    'link_ea_register_title',
  ];

  it.each(Object.keys(LOCALES))('%s has every new key, non-empty, and every retired key marked', (loc) => {
    const m = ns(LOCALES[loc as keyof typeof LOCALES]);
    for (const k of NEW) {
      expect(typeof m[k], `${loc}.${k}`).toBe('string');
      expect(m[k].trim(), `${loc}.${k}`).not.toBe('');
      expect(m[k], `${loc}.${k} must not be a retired marker`).not.toMatch(/^\[retired/);
    }
    for (const k of RETIRED) expect(m[k], `${loc}.${k}`).toMatch(/^\[retired r402 — /);
    // Only the frame title interpolates, and it takes the form's name.
    expect(m.viewer_frameTitle).toContain('{form}');
    for (const k of NEW.filter((x) => x !== 'viewer_frameTitle')) expect(m[k], `${loc}.${k}`).not.toMatch(/[{}]/);
  });

  it('no screen or component renders a retired key', () => {
    const files = [
      'app/payroll/statutory-forms/page.tsx',
      'app/payroll/statutory-forms/open/page.tsx',
      'app/payroll/statutory-forms/[formId]/page.tsx',
      'app/payroll/statutory-forms/ea/page.tsx',
      'app/payroll/statutory-forms/pcb2ii/page.tsx',
      'app/payroll/statutory-forms/ea/view/page.tsx',
      'app/payroll/statutory-forms/pcb2ii/view/page.tsx',
    ];
    for (const f of files) {
      const src = code(f);
      for (const k of RETIRED) {
        // `as 'link_ea_more'` is a type cast on a catalog-supplied key, not a render of that key.
        expect(src.replace(/as '[a-z_0-9]+'/g, ''), `${f} renders ${k}`).not.toMatch(new RegExp(`['"\`]${k}['"\`]`));
      }
    }
    // And no catalog entry names one.
    const named = MY_STATUTORY_LINKS.flatMap((l) => [l.labelKey, l.hintKey, l.descriptionKey, l.secondaryLabelKey, l.extrasLabelKey]);
    for (const k of RETIRED) expect(named, k).not.toContain(k);
  });
});

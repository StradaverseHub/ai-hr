/**
 * Feedback 4a1abc4a — THE ENTITLEMENT TABLE EDITOR SILENTLY WIPED THE TABLE IT WAS OPENED ON.
 *
 * ── THE DEFECT, END TO END ──────────────────────────────────────────────────────────────────────────
 * `components/leave/entitlement-bands-editor.tsx` seeds its rows with `useState(initial.length ? initial
 * : DEFAULT_BANDS)`. useState reads its argument ONLY on the first mount. The Edit control on
 * `app/admin/leave/entitlements/templates/page.tsx` is a next/link `Link` to `?editTemplate=…`, so
 * clicking it is a CLIENT-SIDE navigation: React re-renders the SAME component instance with a new
 * `initial` prop, the component discards it, and the blank new-table row stays on screen over a saved
 * template. Loading that same URL directly is a server render and a fresh mount, so it always looked
 * right — which is why this survived every check that loads a page and reads it.
 *
 * Saving from there was the expensive half. `toStoredBands` coerced the blank cell with `Number(r.days ||
 * 0)`, `validateServiceBands` accepted 0 as a legal entitlement, and `updateEntitlementTemplate` closed
 * the running version and opened a successor granting nothing — under a green "Saved" toast. A template
 * holding 18 days was observed becoming 0 days that way.
 *
 * ── WHY THIS IS A RENDERING TEST ────────────────────────────────────────────────────────────────────
 * The whole defect is "what does the second render do with the new prop", which no source grep and no
 * page-load check can see. §1 reproduces the client-side navigation by re-rendering the screen with a
 * different template, exactly as `next/link` does.
 *
 * §2 is the second half of the fix and does not depend on the first: a BLANK Entitled Days now posts
 * `null` and is refused by name, so even a blank row that reaches the server by some other route cannot
 * be read as "this range grants nothing". A deliberately typed 0 stays legal — that is a real rule, and
 * the point is that the two stop looking alike.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import {
  EntitlementBandsEditor,
  toStoredBands,
  type EditableBand,
} from '../components/leave/entitlement-bands-editor';
import { validateServiceBands, type ServiceBand } from '../core/leave-compute';

/** Off `process.cwd()`, not `import.meta.url`: in the jsdom project `import.meta.url` is an http:// URL
 *  and `fileURLToPath` throws on it before a single test runs. Vitest's cwd is the repo root. */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');
/**
 * ee6b7c69 MOVED THE FORM, NOT THE FIX. The two Cards that were
 * app/admin/leave/entitlements/templates/page.tsx are now a shared block with two mount points (the
 * standalone screen and each leave type's Entitlement step), so the source guard at the end of §1 follows
 * the JSX to where it lives. It is pointed at the block rather than loosened, and the extraction makes it
 * MORE load-bearing, not less: the embedded mount is conditional (`activeStep === 'entitlement'`), so a
 * dropped key there would remount-and-re-seed on a step change and misbehave only when Edit is clicked
 * while already standing on the step — an intermittent version of the same data loss.
 */
const PAGE = 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';

/** One saved template's bands, in the string shape the page's `toEditable` hands the editor. */
const SAVED: EditableBand[] = [
  { fromYears: '0', toYears: '', days: '18.00', carryForwardDays: '', maxBalanceDays: '' },
];
const OTHER: EditableBand[] = [
  { fromYears: '0', toYears: '', days: '25.00', carryForwardDays: '', maxBalanceDays: '' },
];

/**
 * The page's own JSX for this editor, reproduced exactly — including the `key`, which IS the fix. A
 * harness that quietly dropped it would make §1 pass for the wrong reason, so the source guard at the end
 * of §1 checks that the real page still passes the same key.
 */
function Screen({ editing }: { editing: { lineageId: string; bands: EditableBand[] } | null }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <EntitlementBandsEditor
        key={editing?.lineageId ?? 'new'}
        initial={editing ? editing.bands : []}
        maxBands={20}
      />
    </NextIntlClientProvider>
  );
}

/** The same screen WITHOUT the key — the code as it shipped. Present only to prove what the key fixes. */
function UnkeyedScreen({ editing }: { editing: { lineageId: string; bands: EditableBand[] } | null }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <EntitlementBandsEditor initial={editing ? editing.bands : []} maxBands={20} />
    </NextIntlClientProvider>
  );
}

const daysBox = () => screen.getByLabelText('Entitled days') as HTMLInputElement;

/** What the form would actually POST: the editor's one hidden field, parsed. */
const posted = (): ServiceBand[] =>
  JSON.parse((document.querySelector('input[name="serviceBands"]') as HTMLInputElement).value);

describe('§1 4a1abc4a · clicking Edit is a client-side navigation, and the editor must re-read the table', () => {
  it('a template opened by CLICKING Edit shows its stored days, not the blank new-table row', () => {
    // The create form first — this is the page as it stands before the click, and its one row is blank.
    const view = render(<Screen editing={null} />);
    expect(daysBox().value).toBe('');

    // …then the client-side navigation to ?editTemplate=tpl-annual. No unmount, no server render: the same
    // React tree, a new prop. THIS is the moment the defect happened.
    view.rerender(<Screen editing={{ lineageId: 'tpl-annual', bands: SAVED }} />);
    expect(daysBox().value, 'the saved 18 days must be on screen after a client-side Edit').toBe('18.00');
  });

  it('and switching straight from one saved template to another does not carry the first one over', () => {
    // The same defect one step later, and the more dangerous shape: both targets have a table, so the box
    // is never blank and nothing looks wrong. Saving would have written 18 days onto the 25-day template.
    const view = render(<Screen editing={{ lineageId: 'tpl-annual', bands: SAVED }} />);
    expect(daysBox().value).toBe('18.00');
    view.rerender(<Screen editing={{ lineageId: 'tpl-exec', bands: OTHER }} />);
    expect(daysBox().value).toBe('25.00');
  });

  it('WITHOUT the key the same navigation keeps the blank row — the defect, pinned', () => {
    // Not a test of the product: a test of what the product would do if the key were removed, so the next
    // reader can see that `useState(initial)` really does discard the second `initial` and that the key is
    // load-bearing rather than decorative.
    const view = render(<UnkeyedScreen editing={null} />);
    view.rerender(<UnkeyedScreen editing={{ lineageId: 'tpl-annual', bands: SAVED }} />);
    expect(daysBox().value, 'this is the wipe: an 18-day table showing an empty box').toBe('');
  });

  it('the real block passes that key — the harness above is not the thing being shipped', () => {
    const page = read(PAGE);
    expect(page).toMatch(/<EntitlementBandsEditor\s+key=\{editingTemplate\?\.lineageId \?\? 'new'\}/);
  });

  it('…and there is exactly ONE definition of that editor mount, so neither surface can drift', () => {
    // ee6b7c69: the whole reason the tables were EXTRACTED rather than copied into the Entitlement step.
    // A second `<EntitlementBandsEditor` in an app/ page would be a second create/edit form writing the
    // same effective-dated lineage — and the copy without the key would lose tables exactly as the
    // original did, silently, while both still saved.
    // a6fe37fc Round 5 re-pointed the standalone half: `/admin/leave/entitlements/templates` is a
    // redirect stub now and the screen is `/admin/leave-config/entitlement-tables`. The assertion is
    // stronger for following it — a stub can never grow a second editor, and the live page can.
    const mounts = [
      'app/admin/leave/entitlements/page.tsx',
      'app/admin/leave-config/entitlement-tables/page.tsx',
      'app/admin/leave-config/types/page.tsx',
    ];
    for (const f of mounts) {
      expect(read(f), `${f} must mount the shared block, never its own editor`).not.toContain(
        '<EntitlementBandsEditor',
      );
    }
  });
});

describe('§2 4a1abc4a · a blank Entitled Days is a REFUSAL, and a typed 0 is still a rule', () => {
  it('a blank cell posts null, and the server refuses it by name', async () => {
    const user = userEvent.setup();
    render(<Screen editing={{ lineageId: 'tpl-annual', bands: SAVED }} />);
    expect(posted()[0].days, 'the stored figure round-trips untouched').toBe(18);

    await user.clear(daysBox());
    expect(daysBox().value).toBe('');
    // The old code posted 0 here, which is the whole defect: a number nobody typed, indistinguishable from
    // one somebody did.
    expect(posted()[0].days).toBeNull();

    // …and the refusal is the one meant for THIS case, not the generic numeric one it used to fall into.
    // Asserting the message matters: a blank that merely failed some later shape check would still have to
    // be decoded by the operator, and a fixture dying earlier would prove nothing.
    expect(() => validateServiceBands(posted())).toThrowError(/a blank box is not zero/);
  });

  it('…but a deliberately typed 0 saves, because "this range grants nothing" is a real rule', async () => {
    const user = userEvent.setup();
    render(<Screen editing={{ lineageId: 'tpl-annual', bands: SAVED }} />);
    await user.clear(daysBox());
    await user.type(daysBox(), '0');
    expect(posted()[0].days).toBe(0);
    expect(() => validateServiceBands(posted())).not.toThrow();
  });

  it('the coercion that caused it is gone from the poster', () => {
    // `Number(r.days || 0)` turned '' into 0 before it ever left the browser. Pinned on the source because
    // it is one character's worth of drift away from coming back. Comments are stripped first: the poster's
    // own header QUOTES the removed coercion, on purpose, and must not fail the guard against it.
    const src = read('components/leave/entitlement-bands-editor.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toContain('Number(r.days || 0)');
    expect(toStoredBands([{ fromYears: '0', toYears: '', days: '', carryForwardDays: '', maxBalanceDays: '' }])[0].days).toBeNull();
  });
});

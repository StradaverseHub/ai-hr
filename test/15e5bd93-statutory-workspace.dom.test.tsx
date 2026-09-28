/**
 * Item 15e5bd93 (r352) — THE STATUTORY WORKSPACE, DRIVEN THROUGH REAL EVENTS.
 *
 * The reporter asked for the per-body "Open settings" expand to go, and for one Save for the tab. Two of
 * the three things that can quietly go wrong with that are invisible to both a source scan and a
 * static render, because they are about what the CONSOLIDATED PAYLOAD contains after somebody types:
 *
 *  (1) THE PACK FLAG. `lib/tab-save-dom.ts syncCarriedValues` copies a VISIBLE control's value into every
 *      hidden input of the same name in a sibling section of the same scope — the behaviour the personnel
 *      cards need, and exactly wrong here, because each of the eight body editors carries a visible
 *      `country` for its postal address. While the SSM / MyInvois card had its own Save it posted a hidden
 *      `country="MY"` safely; inside this scope that would have arrived as "Malaysia" and been handed to
 *      `packFor()`. The card posts `filingCountry` instead — the name r226 coined one file over for the
 *      identical collision. Nothing static can prove the payload is clean; this does.
 *
 *  (2) THE SIGNATORY. `diffTab` SKIPS a hidden input it cannot prove is user-facing, and
 *      `components/employee-search-field.tsx` posts its choice through one. So a signatory-only edit would
 *      have left the bar reading "No unsaved changes", Save disabled, and the admin's pick thrown away on
 *      the next navigation — silently. `hiddenInputIsUserFacing` now recognises the searchable-field shape.
 *
 * And (3) the promise itself: an edit to one body SURVIVES selecting another, because the seven panes you
 * are not looking at are hidden rather than unmounted.
 *
 * ⚠️ IT MOUNTS THE REAL `CompanyPanel`, not a stand-in shaped like it. Every one of the three faults above
 * lives in the interaction between that component's markup and the shared scope's DOM walker; a fixture
 * would be a second opinion about the markup rather than a test of it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

const { refresh, toastSuccess, toastError } = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));

import messages from '../messages/en.json';
import { CompanyPanel, type PanelCompany } from '../components/company-panel';
import { __resetUnsavedGuards } from '../lib/unsaved-changes';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import type { TabSaveResult } from '../lib/tab-save-sections';

const org = messages.admin.organization as Record<string, string>;

const company: PanelCompany = {
  id: 'c1',
  name: 'Demo Sdn Bhd',
  country: 'MY',
  currency: 'MYR',
  registrationNo: null,
  companyLabel: null,
  industry: null,
  website: null,
  businessType: null,
  addressLine1: null,
  addressLine2: null,
  addressLine3: null,
  city: null,
  state: null,
  addressCountry: null,
  postcode: null,
  phone: null,
  fax: null,
  archivedAt: null,
  inUse: true,
  parentId: null,
  hasLogo: false,
  defaultPayrollCycle: 'Monthly',
};

const noop = () => undefined;

function mount(save: (fd: FormData) => Promise<TabSaveResult>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
      <CompanyPanel
        company={company}
        companies={[{ id: 'c1', name: 'Demo Sdn Bhd' }]}
        statutory={{
          epfEmployerNo: 'E123',
          socsoEmployerCode: 'S123',
          lhdnEmployerNo: 'L123',
          myinvoisTin: null,
          ssmRegistrationNo: null,
          hrdfStatus: 'mandatory',
        }}
        bankProfiles={[]}
        statutoryAuthorities={[
          {
            id: 'sa1',
            authority: 'epf',
            accountNo: 'ACC-1',
            bankProfileId: null,
            addressLine1: null,
            addressLine2: null,
            addressLine3: null,
            city: null,
            state: null,
            postcode: null,
            // The address country the body's editor renders as a VISIBLE select — the value that would be
            // copied over a hidden `country` on the registrations card if the flag were still called that.
            country: 'Malaysia',
            phone: null,
            email: null,
            signatoryPersonId: null,
          },
        ]}
        signatories={[
          { personId: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' },
          { personId: 'p2', name: 'Bala a/l Muthu', employeeCode: 'EMP-0002' },
        ]}
        stateOptions={[]}
        activeCycleNames={['Monthly']}
        initialTab="statutory"
        actions={{
          updateCompany: noop,
          archiveCompany: noop,
          deleteCompany: noop,
          setParent: noop,
          setStatutory: noop,
          setBankProfile: noop,
          removeBankProfile: noop,
          setStatutoryAuthority: noop,
          removeStatutoryAuthority: noop,
          setCompanyLogo: noop,
          removeCompanyLogo: noop,
          updateCompanyDefaultCycle: noop,
          saveGeneralTab: async () => ({ ok: true, saved: [] }),
          saveStatutoryTab: save,
        }}
      />
    </NextIntlClientProvider>,
  );
}

/** The workspace pane for one body — hidden or not, it is in the tree. */
const paneOf = (body: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-statutory-workspace="${body}"]`);
  expect(el, `${body} has a workspace pane`).not.toBeNull();
  return el!;
};

/** The rail row's selection button for one body. */
const railButton = (body: string): HTMLElement => {
  const row = document.querySelector<HTMLElement>(`[data-statutory-body="${body}"]`);
  expect(row, `${body} has a rail row`).not.toBeNull();
  return within(row!).getByRole('button');
};

const saveBar = () => document.querySelector<HTMLElement>('[data-tab-save-scope="statutory"] [data-tab-save-bar]')!;

const fieldIn = (pane: HTMLElement, name: string): HTMLInputElement => {
  const el = pane.querySelector<HTMLInputElement>(`[name="${name}"]`);
  expect(el, `${name} is in the pane`).not.toBeNull();
  return el!;
};

beforeEach(() => {
  __resetUnsavedGuards();
  vi.clearAllMocks();
});

describe('15e5bd93 — the rail never collapses and the workspace is already open', () => {
  it('opens on the first body with every field visible, and the other seven mounted but hidden', () => {
    mount(async () => ({ ok: true, saved: [] }));
    // Eight rows, eight panes, one visible.
    expect(document.querySelectorAll('[data-statutory-body]')).toHaveLength(STATUTORY_AUTHORITIES.length);
    const visible = [...document.querySelectorAll<HTMLElement>('[data-statutory-workspace]')].filter(
      (p) => !p.classList.contains('hidden'),
    );
    expect(visible.map((p) => p.getAttribute('data-statutory-workspace'))).toEqual([STATUTORY_AUTHORITIES[0]]);
    // Nothing to expand: the field is there, not behind a control.
    expect(fieldIn(paneOf('epf'), 'accountNo').value).toBe('ACC-1');
    expect(screen.queryByText(org.authorityOpen)).toBeNull();
  });

  it('keeps an edit to one body when another body is selected (hidden, not unmounted)', async () => {
    const u = userEvent.setup();
    mount(async () => ({ ok: true, saved: [] }));
    await u.clear(fieldIn(paneOf('epf'), 'accountNo'));
    await u.type(fieldIn(paneOf('epf'), 'accountNo'), 'EDITED-EPF');
    await u.click(railButton('ptptn'));
    expect(paneOf('epf').classList.contains('hidden'), 'EPF is hidden now').toBe(true);
    expect(paneOf('ptptn').classList.contains('hidden'), 'PTPTN is on screen').toBe(false);
    expect(fieldIn(paneOf('epf'), 'accountNo').value, 'the edit survived the switch').toBe('EDITED-EPF');
    // …and the tab is still dirty, because the scope reads the hidden pane too.
    expect(saveBar().textContent).not.toContain(messages.components.tabSave.noChanges);
  });
});

describe('15e5bd93 — the one Save, and what its payload contains', () => {
  /**
   * DEFECT (1). The registrations card's pack flag must reach the server as 'MY', and there must be no
   * `country` on that section at all for `syncCarriedValues` to poison. Both halves are asserted, because
   * a rename that only removed the hidden input would post no flag and default the pack silently.
   */
  it('posts the registrations card under filingCountry=MY, with no address country to collide', async () => {
    const u = userEvent.setup();
    let seen: FormData | null = null;
    mount(async (fd) => {
      seen = fd;
      return { ok: true, saved: ['identity'] };
    });
    await u.type(document.querySelector<HTMLInputElement>('[name="ssmRegistrationNo"]')!, '202301001234');
    await u.click(within(saveBar()).getByRole('button', { name: messages.components.tabSave.saveChanges }));
    expect(seen, 'the save action ran').not.toBeNull();
    const fd = seen as unknown as FormData;
    expect(fd.get('sections')).toBe('identity');
    expect(fd.get('section.identity.ssmRegistrationNo')).toBe('202301001234');
    expect(fd.get('section.identity.filingCountry'), 'the pack flag').toBe('MY');
    expect(
      fd.get('section.identity.country'),
      'a hidden `country` here would have been overwritten with the EPF address country',
    ).toBeNull();
    // The body's own address country is untouched and still posts under `country` on ITS section.
    expect(fd.get('section.epf.country'), 'an untouched body is not in the payload at all').toBeNull();
  });

  /**
   * DEFECT (2). The signatory travels in a hidden input. Before this round `diffTab` skipped it, so this
   * whole interaction produced "No unsaved changes" and a disabled Save — the pick went nowhere.
   */
  it('a signatory-only pick makes the tab dirty, and reaches the payload with a readable caption', async () => {
    const u = userEvent.setup();
    let seen: FormData | null = null;
    mount(async (fd) => {
      seen = fd;
      return { ok: true, saved: ['epf'] };
    });
    const pane = paneOf('epf');
    const combo = pane.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await u.type(combo, 'Aminah');
    await u.click(await within(pane).findByText(/Aminah binti Ali/));
    expect(pane.querySelector<HTMLInputElement>('input[name="signatoryPersonId"]')!.value).toBe('p1');
    /**
     * ⚠️ `waitFor`, AND THE REASON IS THE FIX ITSELF. The searchable field emits NO `input` event for the
     * pick: it commits from `onMouseDown` into React state, and the value lands in a hidden input. The
     * scope's synchronous `input`/`change` pass therefore cannot see it — what sees it is the
     * click/keyup/MutationObserver pass, which is coalesced into a requestAnimationFrame. So the bar goes
     * dirty one frame later, and an assertion made in the same tick would be asserting the timing rather
     * than the behaviour. (Before this round it never went dirty at all, frame or no frame.)
     */
    await waitFor(() => expect(saveBar().querySelector('[data-tab-save-count]')).not.toBeNull());
    expect(saveBar().textContent).not.toContain(messages.components.tabSave.noChanges);
    expect(saveBar().querySelector('[data-tab-save-count]')!.textContent).toContain('1');
    expect(
      saveBar().querySelector('[data-tab-save-changed]')!.textContent,
      'the bar names the body that changed',
    ).toBe(org.authority_epf);
    /**
     * THE REVIEW TABLE MUST READ LIKE A SENTENCE A PERSON CAN CHECK, on both axes:
     *   · the ROW CAPTION comes from `EmployeeSearchField`'s `fieldLabel`, because this control is
     *     deliberately not wrapped in a <label> (that would attach itself to the wrong input) and the
     *     scope has nothing else to read — without it the row would be headed "Signatory Person Id";
     *   · the VALUE comes from `controlDisplay`, which now reads the visible `[role="combobox"]` beside
     *     the hidden input — without it the table would show the person id at the reader.
     */
    await u.click(within(saveBar()).getByRole('button', { name: messages.components.tabSave.reviewChanges }));
    const row = saveBar().querySelector<HTMLElement>('[data-change-row="epf.signatoryPersonId"]')!;
    expect(row, 'the signatory change is a row of the review table').not.toBeNull();
    expect(row.textContent, 'captioned by the field, not by its column name').toContain(org.authoritySignatory);
    expect(row.textContent, 'and the NEW value reads as the person, not as their id').toContain('Aminah binti Ali');
    expect(row.textContent, 'the id is never shown').not.toContain('p1');
    await u.click(within(saveBar()).getByRole('button', { name: messages.components.tabSave.saveChanges }));
    const fd = seen as unknown as FormData;
    expect(fd.get('sections')).toBe('epf');
    expect(fd.get('section.epf.signatoryPersonId')).toBe('p1');
    // The body written is the section id; the hidden copy rides along but the server ignores it.
    expect(fd.get('section.epf.authority')).toBe('epf');
    expect(fd.get('companyId'), 'the one trusted top-level id').toBe('c1');
    expect(fd.get('tab'), 'so the reader lands back on this tab').toBe('statutory');
  });

  /**
   * ONE SAVE FOR THE WHOLE TAB: two different bodies plus the registrations card, one press, and the bar
   * names all three. This is the shape the approved drawing shows ("2 bodies changed — EPF, LHDN").
   */
  it('saves several bodies and the registrations card together, naming each of them on the bar', async () => {
    const u = userEvent.setup();
    let seen: FormData | null = null;
    mount(async (fd) => {
      seen = fd;
      return { ok: true, saved: ['identity', 'epf', 'lhdn'] };
    });
    await u.type(document.querySelector<HTMLInputElement>('[name="myinvoisTin"]')!, 'C12345678900');
    await u.clear(fieldIn(paneOf('epf'), 'accountNo'));
    await u.type(fieldIn(paneOf('epf'), 'accountNo'), 'EPF-NEW');
    await u.click(railButton('lhdn'));
    await u.clear(fieldIn(paneOf('lhdn'), 'lhdnEmployerNo'));
    await u.type(fieldIn(paneOf('lhdn'), 'lhdnEmployerNo'), 'E-999');

    const named = saveBar().querySelector<HTMLElement>('[data-tab-save-changed]')!;
    expect(named.textContent).toBe(
      [org.statutoryIdentityMY, org.authority_epf, org.authority_lhdn].join(' · '),
    );

    await u.click(within(saveBar()).getByRole('button', { name: messages.components.tabSave.saveChanges }));
    const fd = seen as unknown as FormData;
    expect(String(fd.get('sections')).split(','), 'exactly the three dirty sections').toEqual([
      'identity',
      'epf',
      'lhdn',
    ]);
    expect(fd.get('section.identity.myinvoisTin')).toBe('C12345678900');
    expect(fd.get('section.epf.accountNo')).toBe('EPF-NEW');
    expect(fd.get('section.lhdn.lhdnEmployerNo')).toBe('E-999');
    // An untouched body contributes NOTHING — its service is never called, so no event is appended for it.
    for (const body of ['socso', 'eis', 'hrdf', 'zakat', 'ptptn', 'tabung_haji']) {
      expect(fd.get(`section.${body}.accountNo`), body).toBeNull();
    }
  });

  /**
   * THE UNSAVED-CHANGES GUARD, which the reporter's approved list names explicitly. It is the shared one
   * (lib/unsaved-changes.ts) — asserted here through the TAB STRIP, because that is the route a reader
   * takes off this tab and the one no `beforeunload` can see.
   */
  it('asks before a dirty statutory tab is left', async () => {
    const u = userEvent.setup();
    mount(async () => ({ ok: true, saved: [] }));
    await u.type(document.querySelector<HTMLInputElement>('[name="ssmRegistrationNo"]')!, 'X');
    await u.click(screen.getByRole('tab', { name: org.tabGeneral }));
    expect(await screen.findByText(messages.components.tabSave.unsavedTitle)).toBeTruthy();
    // Cancel keeps the reader on Statutory with the edit intact — that is what "stay put" means.
    await u.click(screen.getByRole('button', { name: messages.components.tabSave.cancel }));
    expect(screen.getByRole('tab', { name: org.tabStatutory }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector<HTMLInputElement>('[name="ssmRegistrationNo"]')!.value).toBe('X');
  });
});

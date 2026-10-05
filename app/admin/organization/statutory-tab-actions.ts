'use server';

/**
 * 15e5bd93 REVISION 4 (r372) — ONE "Save all changes" for the dedicated Statutory Payment Setup screen.
 *
 * ── RESTORED FROM r352 (d991c149), RE-POINTED, NOT REINVENTED ─────────────────────────────────────
 * r352 built exactly this writer for a rail-plus-workspace inside the company panel's Statutory tab and
 * r353 deleted it. The reporter has now contested the two shapes that replaced it, and their three
 * fields read as one document ask for the thing this writer already does: every body on one screen,
 * every field open, ONE Save. So this is r352's module recovered at its own path — same services, same
 * payload shapes, same absences, same validation — pointed at
 * `app/admin/organization/[companyId]/statutory/page.tsx` instead of at a tab pane.
 *
 * ── WHY IT IS ITS OWN MODULE AND NOT A NINTH EXPORT OF app/admin/actions.ts ───────────────────────
 * A route-local `'use server'` module is the established shape in this tree (app/admin/settings/actions.ts,
 * app/admin/loans/actions.ts, app/admin/attendance/shift-actions.ts, …), and NOTHING here needs anything
 * private to that 1700-line file. What it does need — the service, the pack registry, the session and
 * `ORGANIZATION` — are all importable.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────────
 * It is not a blanket write, and it is not a new writer. It reaches the SAME service the per-card action
 * in app/admin/actions.ts reaches (`setCompanyStatutoryAuthorityAction` → `upsertCompanyStatutoryAuthority`
 * plus the filing half through `pack.companyStatutory.set`), with the same payload shapes, the same
 * absences and the same validation. Nothing about the service, its cross-entity checks or its events
 * changed for this item — only which button reaches them.
 *
 * ⚠️ ONLY DIRTY SECTIONS ARE WRITTEN, AND THAT IS NOT COSMETIC. The client names them in `sections`; a
 * body the administrator did not touch is not in the list, its service is never called, and no event is
 * appended for it. Writing all eight on every Save would CREATE a `company_statutory_authority` row for
 * every body and flip every "Not set up" card to "Set up" — a screen-wide Save silently registering eight
 * statutory bodies is the worst outcome this round could ship. The loop below is the line that prevents
 * it: `if (!requested.includes(section)) continue;`.
 *
 * A SECTION NAME THIS SCREEN DOES NOT OWN IS REFUSED OUTRIGHT, before anything is written:
 * `COMPANY_STATUTORY_TAB_SECTION_ORDER` is the whole vocabulary — the eight bodies and nothing else — so
 * a crafted payload naming `company`, `identity`, `bank` or `delete` cannot reach a writer through this
 * door.
 *
 * IT RETURNS RATHER THAN REDIRECTS, unlike the per-card actions beside it, because a redirect cannot say
 * WHICH of eight writes failed. `saved` names the sections that committed, so a partial failure leaves the
 * body that did not commit still marked edited on screen rather than silently discarded — and the reader
 * stays on the screen, which is the reporter's own fourth point.
 */
import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
// ADR-0080 D9/D11 — through the PACK FACADE, not `core/statutory-authority` directly. The pack-drift
// ratchet (test/payroll-pack-drift.test.ts) only ever shrinks, and app/admin/actions.ts is on its
// allowlist as audited kernel-contract debt; a NEW file must not add an entry. The facade re-exports the
// same function, so the service, its cross-entity checks and its events are identical — this is the same
// import site app/admin/organization/[companyId]/statutory/page.tsx already uses for the matching read.
import { upsertCompanyStatutoryAuthority } from '@/packs/payroll/service';
import { packFor } from '@/localization/registry';
import { COMPANY_STATUTORY_TAB_SECTION_ORDER } from '@/lib/company-statutory-tab-sections';
import { SECTION_FIELD_PREFIX, SECTIONS_FIELD, type TabSaveResult } from '@/lib/tab-save-sections';
import { ORGANIZATION } from '../_redirects';

type Session = Awaited<ReturnType<typeof getSession>>;

/**
 * "Did the form in front of the operator carry this box at all?"
 *
 * ⚠️ DELIBERATELY THE SAME THREE LINES AS `postedField` IN app/admin/actions.ts, and the duplication is
 * the lesser fault. `company_statutory_my` is written by a PARTIAL PATCH: an ABSENT key means "leave the
 * stored value alone" and `''` means "the operator cleared this box". Reading an absent key as `''` is
 * what would silently blank another body's filing number — the data loss r226 exists to prevent, and on
 * a screen carrying all eight bodies at once it is reachable on every single Save. That helper cannot be
 * exported from a `'use server'` module (only async functions may be), and hoisting it to lib/ would move
 * a contract two guards pin by name. test/company-panel-bank-statutory-layout.test.ts asserts the two
 * agree, so they cannot drift without a red test.
 */
function postedField(formData: FormData, key: string): string | undefined {
  return formData.has(key) ? String(formData.get(key) ?? '') : undefined;
}

/** The HRDF rate as posted, or undefined when the form did not carry the select at all. */
function postedHrdfStatus(formData: FormData): 'not_registered' | 'mandatory' | 'optional' | undefined {
  const raw = String(formData.get('hrdfStatus') ?? '');
  return raw === 'not_registered' || raw === 'mandatory' || raw === 'optional' ? raw : undefined;
}

/**
 * ONE statutory body — the same two-table write `setCompanyStatutoryAuthorityAction` performs.
 *
 * ⚠️ `authority` IS THE SECTION ID, never the form's own hidden copy. The id has already been checked
 * against the closed vocabulary; the hidden input is reader-supplied and eight copies of it are eight
 * chances for a crafted payload to point one body's write at another body's row. Same move, same reason,
 * as forcing the company id from the one trusted top-level value.
 *
 * The filing half is written only when the card actually carried a filing control, and it is a PARTIAL
 * PATCH — so saving EPF cannot touch SOCSO's, LHDN's or HRD Corp's entry on the same row, exactly as
 * before.
 */
async function applyAuthoritySection(s: Session, authority: string, fd: FormData): Promise<void> {
  const companyId = String(fd.get('companyId'));
  await upsertCompanyStatutoryAuthority(s, {
    companyId,
    authority,
    accountNo: (fd.get('accountNo') as string) || null,
    bankProfileId: (fd.get('bankProfileId') as string) || null,
    addressLine1: (fd.get('addressLine1') as string) || null,
    addressLine2: (fd.get('addressLine2') as string) || null,
    addressLine3: (fd.get('addressLine3') as string) || null,
    city: (fd.get('city') as string) || null,
    state: (fd.get('state') as string) || null,
    postcode: (fd.get('postcode') as string) || null,
    country: (fd.get('country') as string) || null,
    phone: (fd.get('phone') as string) || null,
    email: (fd.get('email') as string) || null,
    signatoryPersonId: (fd.get('signatoryPersonId') as string) || null,
  });

  // `filingCountry` is deliberately NOT called `country`: that name is taken on this same card by the
  // body's postal address (a country NAME from the ISO list), and reusing it would post "Malaysia" into
  // packFor(). r226 COINED the name, for the same collision one file over; r352 APPLIED it here, and that
  // application is the fix for a real defect that killed every identity save. It matters MORE on this
  // screen than on the per-body page — there are eight visible postal `country` selects in one scope
  // here, and lib/tab-save-dom.ts `syncCarriedValues` copies a visible control's value into any hidden
  // input of the same name.
  const filingCountry = String(fd.get('filingCountry') ?? '');
  const filing = {
    epfEmployerNo: postedField(fd, 'epfEmployerNo'),
    socsoEmployerCode: postedField(fd, 'socsoEmployerCode'),
    lhdnEmployerNo: postedField(fd, 'lhdnEmployerNo'),
    hrdfStatus: postedHrdfStatus(fd),
  };
  if (filingCountry && Object.values(filing).some((v) => v !== undefined)) {
    const pack = packFor(filingCountry);
    if (!pack?.companyStatutory) throw new Error(`No statutory pack for ${filingCountry}`);
    await pack.companyStatutory.set(s, { companyId, ...filing });
  }
}

export async function saveCompanyStatutoryTabAction(formData: FormData): Promise<TabSaveResult> {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const requested = String(formData.get(SECTIONS_FIELD) ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const order: readonly string[] = COMPANY_STATUTORY_TAB_SECTION_ORDER;
  const unknown = requested.filter((x) => !order.includes(x));
  if (unknown.length > 0) {
    return { ok: false, saved: [], failedSection: unknown[0], error: `Unknown section: ${unknown[0]}` };
  }

  const saved: string[] = [];
  for (const section of order) {
    // ⚠️ THE ONLY-DIRTY LINE. A body the operator did not touch is never written, so a Save cannot create
    // a payment record for it and cannot flip its card from "Not set up" to "Set up".
    if (!requested.includes(section)) continue;
    const fd = statutorySectionFormData(formData, section, companyId);
    try {
      await applyAuthoritySection(s, section, fd);
      saved.push(section);
    } catch (e) {
      if (saved.length > 0) revalidateCompany(companyId);
      return { ok: false, saved, failedSection: section, error: publicErrorMessage(e) };
    }
  }

  revalidateCompany(companyId);
  return { ok: true, saved };
}

/**
 * The company's own screen and the listing both carry statutory facts, so both paths are invalidated —
 * and so is the statutory screen itself, which is where the reader STAYS (`okCompany`'s habit, applied to
 * a save that does not redirect).
 */
function revalidateCompany(companyId: string): void {
  revalidatePath(ORGANIZATION);
  if (companyId) {
    revalidatePath(`${ORGANIZATION}/${companyId}`);
    revalidatePath(`${ORGANIZATION}/${companyId}/statutory`);
  }
}

/**
 * Rebuild one card's own FormData out of the consolidated payload.
 *
 * THE COMPANY IS FORCED FROM THE ONE TRUSTED TOP-LEVEL VALUE, never taken from a section's own hidden
 * copy: eight hidden copies of the same id are eight chances for a crafted payload to point one write at
 * another company.
 *
 * Everything else is taken verbatim, INCLUDING absences — an unpacked section must be indistinguishable
 * from what that card would have posted alone, or the "absent means leave as-is" contract breaks.
 */
function statutorySectionFormData(formData: FormData, section: string, companyId: string): FormData {
  const prefix = `${SECTION_FIELD_PREFIX}.${section}.`;
  const out = new FormData();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    if (field === 'companyId' || field === 'id') continue;
    out.append(field, value);
  }
  out.set('companyId', companyId);
  return out;
}

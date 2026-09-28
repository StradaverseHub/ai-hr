'use server';

/**
 * 15e5bd93 (r352) — ONE "Save Changes" for Organization → a company → STATUTORY.
 *
 * ── WHY IT IS ITS OWN MODULE AND NOT A NINTH EXPORT OF app/admin/actions.ts ───────────────────────
 * A route-local `'use server'` module is the established shape in this tree (app/admin/settings/actions.ts,
 * app/admin/loans/actions.ts, app/admin/attendance/shift-actions.ts, …). Two things recommended it here
 * over growing the 1700-line admin action file: the build brief for this item fenced that file off (other
 * work was in flight against it), and NOTHING in this module needs anything private to it. What it does
 * need — the two services, the pack registry, the session and `ORGANIZATION` — are all importable.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────────
 * It is not a blanket write, and it is not a new writer. It reaches the SAME two services the per-card
 * actions in app/admin/actions.ts reach (`setCompanyStatutoryAction` → `pack.companyStatutory.set`,
 * `setCompanyStatutoryAuthorityAction` → `upsertCompanyStatutoryAuthority` + the filing half), with the
 * same payload shapes, the same absences and the same validation. Nothing about the services, their
 * cross-entity checks or their events changed for this item — only which button reaches them.
 *
 * ONLY DIRTY SECTIONS ARE WRITTEN. The client names them in `sections`; a body the administrator did not
 * touch is not in the list, its service is never called, and no event is appended for it.
 *
 * A SECTION NAME THIS TAB DOES NOT OWN IS REFUSED OUTRIGHT, before anything is written:
 * `COMPANY_STATUTORY_TAB_SECTION_ORDER` is the whole vocabulary, so a crafted payload naming `company`,
 * `bank` or `delete` cannot reach a writer through this door.
 *
 * IT RETURNS RATHER THAN REDIRECTS, unlike the per-card actions beside it, because a redirect cannot say
 * WHICH of nine writes failed. `saved` names the sections that committed, so a partial failure leaves the
 * body that did not commit still marked edited on screen rather than silently discarded.
 */
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { upsertCompanyStatutoryAuthority } from '@/core/statutory-authority';
import { packFor } from '@/localization/registry';
import {
  COMPANY_STATUTORY_TAB_SECTION_ORDER,
  STATUTORY_IDENTITY_SECTION,
} from '@/lib/company-statutory-tab-sections';
import { SECTION_FIELD_PREFIX, SECTIONS_FIELD, type TabSaveResult } from '@/lib/tab-save-sections';
import { ORGANIZATION } from '../_redirects';

type Session = Awaited<ReturnType<typeof getSession>>;

/**
 * "Did the form in front of the operator carry this box at all?"
 *
 * ⚠️ DELIBERATELY THE SAME THREE LINES AS `postedField` IN app/admin/actions.ts, and the duplication is
 * the lesser fault. `company_statutory_my` is written by a PARTIAL PATCH: an ABSENT key means "leave the
 * stored value alone" and `''` means "the operator cleared this box". Reading an absent key as `''` is
 * what would silently blank another body's filing number — the data-loss r226 exists to prevent. That
 * helper cannot be exported from a `'use server'` module (only async functions may be), and hoisting it
 * to lib/ would move a contract two guards pin by name. test/company-panel-bank-statutory-layout.test.ts
 * asserts the two agree, so they cannot drift without a red test.
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
 * The SSM / MyInvois registrations card — the same write `setCompanyStatutoryAction` performs.
 *
 * It keeps reading all five names rather than shrinking to the two boxes the card renders, for the reason
 * that action states: the write is a partial patch and this action serves whatever shape the form had.
 */
async function applyIdentitySection(s: Session, fd: FormData): Promise<void> {
  /**
   * ⚠️ `filingCountry`, NOT `country`, AND THE NAME IS LOAD-BEARING. `setCompanyStatutoryAction` reads
   * `country` because that card used to post its own payload alone. Inside a consolidated scope it cannot:
   * lib/tab-save-dom.ts `syncCarriedValues` copies a VISIBLE sibling control's value into any hidden input
   * of the same name, and every statutory body's editor in this scope carries a visible `country` for its
   * postal address — so a hidden `country` here would arrive as "Malaysia" and be handed to `packFor()`.
   * r226 coined `filingCountry` for exactly this collision one file over; this is that rule applied.
   * `country` is still read as a fallback so a payload of the older shape cannot silently become MY.
   */
  const country = String(fd.get('filingCountry') || fd.get('country') || 'MY');
  const pack = packFor(country);
  if (!pack?.companyStatutory) throw new Error(`No statutory pack for ${country}`);
  await pack.companyStatutory.set(s, {
    companyId: String(fd.get('companyId')),
    epfEmployerNo: postedField(fd, 'epfEmployerNo'),
    socsoEmployerCode: postedField(fd, 'socsoEmployerCode'),
    lhdnEmployerNo: postedField(fd, 'lhdnEmployerNo'),
    myinvoisTin: postedField(fd, 'myinvoisTin'),
    ssmRegistrationNo: postedField(fd, 'ssmRegistrationNo'),
    hrdfStatus: postedHrdfStatus(fd),
  });
}

/**
 * ONE statutory body — the same two-table write `setCompanyStatutoryAuthorityAction` performs.
 *
 * ⚠️ `authority` IS THE SECTION ID, never the form's own hidden copy. The id has already been checked
 * against the closed vocabulary; the hidden input is reader-supplied and nine copies of it are nine
 * chances for a crafted payload to point one body's write at another body's row. Same move, same reason,
 * as forcing the company id from the one trusted top-level value.
 *
 * The filing half is written only when the form actually carried a filing control, and it is a PARTIAL
 * PATCH — so saving EPF cannot touch SOCSO's, LHDN's, MyInvois's or SSM's number, exactly as before.
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

  // `filingCountry` is deliberately NOT called `country`: that name is taken on this same form by the
  // body's postal address (a country NAME from the ISO list), and reusing it would post "Malaysia" into
  // packFor().
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
    if (!requested.includes(section)) continue;
    const fd = statutorySectionFormData(formData, section, companyId);
    try {
      if (section === STATUTORY_IDENTITY_SECTION) await applyIdentitySection(s, fd);
      else await applyAuthoritySection(s, section, fd);
      saved.push(section);
    } catch (e) {
      if (saved.length > 0) revalidateCompany(companyId);
      return { ok: false, saved, failedSection: section, error: (e as Error).message };
    }
  }

  revalidateCompany(companyId);
  return { ok: true, saved };
}

/** The list carries the company's name and archived badge, so both paths are invalidated (okCompany). */
function revalidateCompany(companyId: string): void {
  revalidatePath(ORGANIZATION);
  if (companyId) revalidatePath(`${ORGANIZATION}/${companyId}`);
}

/**
 * Rebuild one card's own FormData out of the consolidated payload.
 *
 * THE COMPANY IS FORCED FROM THE ONE TRUSTED TOP-LEVEL VALUE, never taken from a section's own hidden
 * copy: nine hidden copies of the same id are nine chances for a crafted payload to point one write at
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

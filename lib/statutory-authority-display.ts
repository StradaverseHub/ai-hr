/**
 * HOW A STATUTORY BODY IS DRAWN — the mark, the fallback icon, and which filing number belongs to it.
 *
 * ── WHY THIS IS ITS OWN MODULE (15e5bd93 rev 2, r353) ────────────────────────────────────────────
 * All three of these lived in components/company-panel.tsx while the panel was the only screen that drew
 * a statutory body. The reporter's approved rev-2 redesign gives the bodies a DEDICATED screen
 * (app/admin/organization/[companyId]/statutory), so there are now two client components that must agree
 * about a body's mark and about which of the three filing numbers is its own. Importing one 'use client'
 * screen from the other to share three constants would have pulled the whole company panel into the new
 * route's bundle and made the dependency point the wrong way; a second copy would be two lists that can
 * disagree about what EPF's number is called. So the vocabulary moves here and both screens read it.
 *
 * Plain lib/ rather than core/ for the same reason lib/statutory-authorities.ts gives: it is needed by
 * client components and must not drag the DB client behind it. It holds no rule and no money — a logo
 * path, a Lucide fallback, and the r226 filing-field map.
 */
import {
  BookOpen,
  GraduationCap,
  HandCoins,
  Landmark,
  type LucideIcon,
  Moon,
  PiggyBank,
  ShieldPlus,
  Umbrella,
} from 'lucide-react';

/**
 * The visual mark on each statutory body.
 *
 * ⚠️ THIS REVERSES 3c2f55d7 rev 2, AND THE REASON IT GAVE IS THE REASON IT CAN BE REVERSED. That round
 * refused the official logos in these words: "this repo bundles no remote assets, and reproducing a
 * government agency's mark inside a product needs permission we do not have on file… swapping in a
 * licensed mark later is a one-line change here."
 *
 * efe424b0 (r327) — the reporter ATTACHED all seven marks to the request themselves (KWSP, PERKESO,
 * LHDN, Zakat, PTPTN, Tabung Haji, HRDF). That is the condition the old comment named, and they are the
 * owner of the deployment these identify. The files are committed under public/statutory/ rather than
 * fetched, so the "bundles no remote assets" half still holds exactly as before.
 *
 * ⚠️ THE ICON FALLBACK STAYS, and it is not vestigial: a body with no logo file falls back to its Lucide
 * mark, so adding an authority can never render a blank tile. That property is why AUTHORITY_ICON had a
 * default in the first place and it survives the change.
 */
/**
 * ⚠️ efe424b0 — WHY "SOCSO & EIS" CANNOT BE ONE CONFIGURATION, ONLY ONE GROUP.
 *
 * The request says: consolidate SOCSO and EIS. The EIS card has said for some time that EIS has no
 * filing number of its own because it files under SOCSO's PERKESO employer code, which makes the merge
 * sound free. It is not, and the data says so.
 *
 * MEASURED ON PRODUCTION 2026-09-22, `company_statutory_authority` holds a SEPARATE row per body with
 * its own payment account, bank profile and signatory — and they DIFFER:
 *
 *     eis   | bank=d7347908… | acct=SMSB_EIS        socso | bank=d7347908… | acct=SMSB_SOCSO
 *     eis   | bank=(none)    | acct=E1400003148V    socso | (no counterpart)
 *     socso | sig=af6dfdc1…                          eis   | (no counterpart)
 *
 * So a company can pay EIS on a different account from SOCSO, and one already does. Drawing ONE card
 * backed by SOCSO's row would leave `SMSB_EIS` on file with no screen that can edit it — a setting that
 * still governs a payment, quietly unreachable. That is the failure this note exists to prevent.
 *
 * WHAT CONSOLIDATION THEREFORE MEANS HERE: one GROUP, named for both bodies and carrying the PERKESO
 * mark once, with EIS drawn beneath SOCSO and indented — and BOTH configurations still editable. The
 * filing code stays stated once, because that genuinely is shared; the payment details stay two, because
 * they genuinely are not.
 */
export const AUTHORITY_LOGO: Record<string, string> = {
  epf: '/statutory/kwsp.png',
  socso: '/statutory/perkeso.png',
  // EIS files under PERKESO and is drawn beneath SOCSO — see the consolidation note above.
  eis: '/statutory/perkeso.png',
  lhdn: '/statutory/lhdn.png',
  hrdf: '/statutory/hrdf.png',
  zakat: '/statutory/zakat.png',
  ptptn: '/statutory/ptptn.png',
  tabung_haji: '/statutory/tabunghaji.png',
};

/**
 * The fallback mark, keyed by the same strings as lib/statutory-authorities.ts.
 */
export const AUTHORITY_ICON: Record<string, LucideIcon> = {
  epf: PiggyBank, // retirement savings
  socso: ShieldPlus, // injury / invalidity cover
  eis: Umbrella, // retrenchment cover
  lhdn: Landmark, // the revenue board
  hrdf: GraduationCap, // training levy
  zakat: HandCoins, // religious contribution
  ptptn: BookOpen, // study loan
  tabung_haji: Moon, // pilgrimage savings
};

/**
 * WHICH FILING NUMBER BELONGS TO WHICH BODY (r226).
 *
 * There are TWO numbers per statutory body, and until r226 nothing on screen said so:
 *
 *   • the EMPLOYER ACCOUNT / REFERENCE number — the one on the payment slip. It has always lived on the
 *     body's own record (company_statutory_authority.accountNo, `name="accountNo"`).
 *   • the FILING number — the one that goes on the body's filed form. It lived in a single flat list
 *     above the cards (company_statutory_my), which is what made the two look like duplicates.
 *
 * They are not duplicates. This map puts the second one on the same card as the first, and both are
 * labelled so a reader can tell them apart.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT, because "add the missing ones" is the obvious next edit and it is wrong:
 *
 *   • SSM and MyInvois get NO entry and no card. Neither is a body an employer pays a contribution to,
 *     neither is in STATUTORY_AUTHORITIES, and the SSM number is read by two statutory files we produce
 *     (localization/my/borang-8a.ts:145, localization/my/socso-eis-file.ts:140) — filing it under a
 *     payment card would be actively misleading. They stay in the registrations card on the Statutory
 *     tab, and the dedicated screen shows them read-only in its heading so the operator can check them
 *     without leaving.
 *   • EIS gets no entry either: it files under the SAME PERKESO employer code as SOCSO. A second input
 *     writing socsoEmployerCode would be two controls fighting over one column, and whichever card was
 *     saved second would win. The EIS card says so in words instead (`authorityEisSharesSocso`).
 *   • HRD Corp's filing identity is not a number but a registration STATUS (the levy rate), so it is
 *     handled separately in the card as the same three-value select it has always been.
 *
 * Each card posts ONLY its own field, and the writer is a partial patch, so one card's save cannot blank
 * another's number — see localization/my/company-statutory.ts and setCompanyStatutoryAuthorityAction.
 */
export type MyFilingKey = 'epfEmployerNo' | 'socsoEmployerCode' | 'lhdnEmployerNo';
export const MY_FILING_FIELD: Record<string, { name: MyFilingKey; labelKey: string }> = {
  epf: { name: 'epfEmployerNo', labelKey: 'epfEmployerNo' },
  socso: { name: 'socsoEmployerCode', labelKey: 'socsoEmployerCode' },
  lhdn: { name: 'lhdnEmployerNo', labelKey: 'lhdnENumber' },
};

/**
 * ═══ 15e5bd93 REVISION 3 (r355) — "PAYMENT SETUP" AND "STATUS" ARE TWO FACTS, DERIVED IN ONE PLACE ══
 *
 * The reporter drew the list themselves and their table has BOTH columns. They are not the same fact, and
 * the approved plan says so to them in plain words rather than printing a column that looks like
 * information and is really an echo:
 *
 *     Payment Setup  =  we hold a payment record for that body  (a `company_statutory_authority` row)
 *     Status         =  it is actually contributing
 *
 * ⚠️ FOR SEVEN BODIES THESE COINCIDE, AND SAYING SO IS THE HONEST VERSION. There is no per-body
 * enable/disable column in the schema — `company_statutory_authority` holds an account, a bank profile, an
 * address and a signatory, and nothing that switches a body off — so for those seven the only checkable
 * answer to "is it contributing" is whether the setup exists at all. INVENTING a switch to make the second
 * column independent is what CLAUDE.md §8 forbids ("a shared caption may say only what is true of every
 * member and checkable from this repo"), and it would also be a rule change the plan did not ask for.
 *
 * ⚠️ FOR HRD CORP THEY GENUINELY DIFFER, AND THAT IS WHY THE COLUMN IS WORTH DRAWING. `hrdf_status` on
 * `company_statutory_my` is not_registered | mandatory | optional, and it is what decides whether the levy
 * is charged at all. So "Configured + Inactive" — payment details on file, no contribution — is a real,
 * reachable state, and a company in it must not be told its HRD Corp levy is Active.
 *
 * THE HRDF HALF IS PAYROLL'S OWN RULE, NOT A UI GUESS, and this is the evidence:
 *   · core/payroll.ts:3430   `const hrdfStatus = coStat?.hrdfStatus ?? 'not_registered'` — a MISSING
 *                            identity row resolves to not_registered.
 *   · core/payroll.ts:5995   `const hrdfChargeable = hrdfStatus !== 'not_registered'`.
 * So "contributing" here is exactly "payroll would charge the levy", including for a company with no
 * identity row at all — which is a statement about what the system WILL DO, not about a registration
 * decision somebody made. (The identity card's HRDF caption is the other half and says "Not set" for that
 * company, because an absent box asserts nothing about a DECISION.)
 *
 * A pure function in lib/ so the screen, the guards and any future reader all derive it the same way; a
 * second derivation is how the two columns would drift into one.
 */
export type StatutoryRowStatus = {
  /** A `company_statutory_authority` row exists for this body. */
  configured: boolean;
  /** This body is actually contributing. */
  contributing: boolean;
};
export function statutoryRowStatus(
  authority: string,
  hasRecord: boolean,
  hrdfStatus: 'not_registered' | 'mandatory' | 'optional' | null | undefined,
): StatutoryRowStatus {
  return {
    configured: hasRecord,
    contributing: authority === 'hrdf' ? (hrdfStatus ?? 'not_registered') !== 'not_registered' : hasRecord,
  };
}

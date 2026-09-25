/**
 * 20f6c6a8 — THE PAYMENT SUBMISSION REGISTRY: every file this system can hand an employer to file,
 * declared ONCE as data. PURE OF SCREEN AND ROUTE: no React, no Response, no `next/*`.
 *
 * ⚠️ THE SHAPE IS COPIED FROM `lib/kwsp-borang-a-file.ts`, DELIBERATELY AND FOR ITS REASON. That module
 * states the KWSP layout once, as `BORANG_A_FILE_FIELDS`, so the writer, the verifier, the report and the
 * test all read the SAME numbers rather than four transcriptions of them. This file does the same thing
 * one level up: the SCREEN, the DOWNLOAD ROUTE and the TESTS all read `SUBMISSION_FORMATS`, so "which
 * files can this employer file" has one answer instead of three that can drift.
 *
 * ── THE SCREEN MUST NOT BRANCH ON AUTHORITY, AND THE TYPE IS WHAT ENFORCES IT ─────────────────────
 * `app/payroll/statutory-forms/[formId]/page.tsx` is the cautionary example in this repo: it carries
 * `formId === 'my.cp39'`, `formId === 'my.socso-eis'`, `formId === 'my.borang-8a'` and
 * `formId === 'my.borang-a'` as four literal branches, so every new form reopens that component. Nothing
 * below exposes an authority the screen could switch on for behaviour: a format carries its own labels,
 * its own group, its own provenance and its own builder, and the screen renders whatever the registry
 * hands it. Adding the next format is adding an entry HERE.
 *
 * ── `verification` IS REQUIRED ON EVERY ENTRY, AND THAT IS THE POINT OF THIS ROUND ────────────────
 * The governing lesson is written in `lib/kwsp-borang-a-file.ts`'s header and it cost a wrong filing to
 * learn: the EPF layout was once transcribed from REVERSE-ENGINEERED FIELD TABLES with no sample, and it
 * "put the wages where the employer's contribution belongs and the two contributions added together where
 * the employee's belongs. A file with the right shape and the wrong numbers in it is the worst kind: it
 * looks valid."
 *
 * The naive reading of that lesson is "only ship formats that have a filed specimen". That is not what it
 * says, and enforcing it here would have DELETED a capability this product already ships (see LHDN below).
 * What the lesson actually demands is that a file's PROVENANCE is never invisible. So `verification` is a
 * REQUIRED field on every descriptor — there is no default and no optional marker — and a format cannot be
 * added to this registry without stating, in public, what evidence stands behind its bytes. The screen
 * prints that answer next to the download button. A future format transcribed from a field table is not
 * forbidden; it is forbidden from being SILENT about being transcribed from a field table.
 *
 * ── GENERATING A FILE WRITES NOTHING. THIS IS A HARD RULE OF THE MODULE ───────────────────────────
 * No `statutory_report` row, no domain event, no status change on a payroll run. Producing a file is not
 * evidence that anything was filed with anybody, and a row that says otherwise is a lie the audit trail
 * then carries forever. `db/schema.ts` `STATUTORY_FILED_STATUSES` is the OWNED definition of "filed" and
 * this module neither reads a second one into existence nor writes that column.
 *
 * ⚠️ THE TWO EXISTING `/payroll/reports/*` FILE ROUTES DO WRITE — `recordFileReport(...)`, an append-only
 * artefact plus a domain event, on every download (app/payroll/reports/cp39-file/route.ts:23 and
 * app/payroll/reports/socso-eis-file/route.ts:28). That behaviour is THEIRS and is left exactly as it is;
 * this module is not a refactor of those routes. The builders below therefore call the READ layer
 * (`loadBorangAFile`, `loadBorang8AFile`, `cp39FileForBatch`) and never the route, which is why the same
 * bytes can be produced here without the artefact. `cp39FileForBatch` is select-only — audited, it opens a
 * `withTenant` transaction containing nothing but `.select(...)`.
 *
 * ── THE ONE ADR-0080 D1 DEVIATION IN THIS MODULE, NAMED RATHER THAN SLIPPED IN ───────────────────
 * D1 says `app/` reaches a pack only through the generic core seam, and the three sibling loaders keep
 * that promise: `loadBorangAFile`, `loadBorang8AFile` and `loadCp39Form` all go through `reportPreview`
 * and none of them names `localization/my`. The LHDN e-DATA FILE has no such read — `cp39FileForBatch`
 * IS the read, it lives in the pack, and the shipped route `app/payroll/reports/cp39-file/route.ts:8`
 * imports it directly for want of an alternative. This registry does the same rather than inventing a
 * parallel `reportPreview`-based read of the e-Data file, which would be a second source of the same
 * figures and a much larger change than this round. The deviation is ONE import, it matches what the
 * existing route already does, and building that generic read is the change that removes it.
 *
 * ── SALARY IS DELIBERATELY EMPTY, AND SAYING SO IS THE FEATURE ────────────────────────────────────
 * A bank payment file moves real money and every bank's layout differs. `SUBMISSION_GROUPS` declares the
 * group anyway, with a note explaining the absence, because a missing section reads as an oversight and a
 * present one that explains itself reads as a decision. Same reason `MY_PLANNED_FORMS` exists on the
 * statutory-forms shelf.
 */
import { borangAUploadFilename, loadBorangAFile } from '../borang-a/shared';
import { loadBorang8AFile } from '../borang-8a/shared';
import { perkesoUploadFilename } from '@/lib/perkeso-socso-file';
import { scopedAdmin } from '@/lib/scope';

/**
 * Which shelf a format sits on. ORDER IS DECLARED, NOT ALPHABETICAL, and the screen iterates this array.
 *
 * `salary` first because it is what an operator is looking for when they think "pay people"; the two
 * statutory shelves after it, because they are what the month owes once people have been paid.
 */
export const SUBMISSION_GROUPS = [
  {
    key: 'salary',
    labelKey: 'groupSalary',
    /**
     * Rendered when the group has no formats. NOT a placeholder for a format: the absence is the
     * decision, and it is explained rather than hidden. See the header.
     */
    emptyNoteKey: 'groupSalaryEmpty',
  },
  { key: 'bankStatutory', labelKey: 'groupBankStatutory', emptyNoteKey: 'groupBankStatutoryEmpty' },
  {
    key: 'governmentStatutory',
    labelKey: 'groupGovernmentStatutory',
    emptyNoteKey: 'groupGovernmentStatutoryEmpty',
  },
] as const;

export type SubmissionGroupKey = (typeof SUBMISSION_GROUPS)[number]['key'];

/**
 * WHAT STANDS BEHIND THIS FORMAT'S BYTES. Required on every descriptor — see the header for why this is
 * the one field the registry refuses to let an author skip.
 *
 * The three values are ordered by strength of evidence, and the gap between the second and the third is
 * the gap that produced the wrong EPF file:
 *
 *   `filed-file`          — a REAL file the customer actually filed with the agency is in `test/fixtures/`
 *                           and a golden test asserts our bytes equal it. The strongest claim available,
 *                           and the only one that has ever caught a transposed column.
 *   `specification-sample`— the agency's own PUBLISHED specification, plus a WORKED EXAMPLE from it that a
 *                           test drives the writer with. Weaker than it first sounds, and the difference
 *                           is worth stating: there is no sample FILE on disk to compare against, so the
 *                           test reconstructs the expected record from the same field table the writer
 *                           read. Two transcriptions of one table agreeing is not the same evidence as a
 *                           filed document disagreeing with you — and nothing produced this way has been
 *                           through the agency's portal either.
 *   `field-table-only`    — a field table with NO sample of any kind. THIS IS THE ONE THAT WENT WRONG.
 *                           Declarable so that a format in this state must say so on screen; there is
 *                           deliberately no entry carrying it today.
 */
export type FormatVerification = 'filed-file' | 'specification-sample' | 'field-table-only';

/** What a builder hands back. `bytes` is the file's exact characters; nothing re-encodes them later. */
export type SubmissionBuild =
  | { ok: true; filename: string; bytes: string; contentType: string }
  /** An operator-fixable refusal, already in words they can act on. NEVER a partial or patched file. */
  | { ok: false; status: number; message: string };

/** What every builder is handed. `query` carries the per-generation inputs a format may declare. */
export type SubmissionBuildInput = {
  companyId: string;
  periodKey: string;
  query: URLSearchParams;
};

type FormatCommon = {
  /** Stable id. Appears in the download URL, so it is treated as attacker-controlled on the way back in. */
  id: string;
  /**
   * The agency this file is filed with, for DISPLAY ONLY.
   *
   * ⚠️ NOTHING MAY BRANCH ON THIS. It is here so the screen can print "KWSP" beside a row, not so a
   * caller can ask "is this the EPF one" and do something different. See the header.
   */
  authority: string;
  group: SubmissionGroupKey;
  /** Sort key within the group. Declared, so position is a decision and not an accident of array order. */
  rank: number;
  /** i18n key under `payroll.paymentSubmission.format`. */
  labelKey: string;
  descriptionKey: string;
  /**
   * WHAT THE DOWNLOAD POP-UP HAS TO ASK FOR before this file can be produced. Declared by the FORMAT and
   * read by the modal (e78fd03d), so the selection follows the registry rather than a branch on the group.
   *
   *   'month'       — company + year + payroll month. Every format today, and every statutory return
   *                   genuinely IS one filing per month: LHDN, KWSP and PERKESO each want the month
   *                   consolidated, whatever runs it was paid in.
   *   'month-cycle' — the same, plus WHICH RUN of that month. One payroll month can hold a regular run, a
   *                   bonus run and an advance with different payment dates (ADR-0024 multi-cycle;
   *                   `payroll_batch.run_seq` is the cycle's identity), so a file that pays PEOPLE has to
   *                   say which of them it pays.
   *
   * ⚠️ NOTHING DECLARES `'month-cycle'` TODAY, AND THAT IS THE HONEST STATE rather than an oversight. The
   * only file that would need it is a bank salary payment file, and the `salary` shelf is deliberately
   * empty — a bank payment file moves real money and every bank's layout differs (see the header). The
   * union is widened and the MODAL reads it so that the day such a format is added it declares
   * `'month-cycle'` and the cycle field appears with no screen change — the same property this registry
   * already has to keep for the row itself. It is NOT a picker sitting on the screen waiting for a
   * consumer: for a `'month'` format the control does not exist.
   */
  periodKind: 'month' | 'month-cycle';
  /** REQUIRED. See `FormatVerification` — the registry's whole ratchet. */
  verification: FormatVerification;
};

/**
 * A format, available or not.
 *
 * A DISCRIMINATED UNION, SO AN UNAVAILABLE FORMAT HAS NO `build` AT THE TYPE LEVEL — the same device
 * `app/payroll/statutory-forms/page.tsx` uses for `MY_PLANNED_FORMS`, "whose type makes an action on one
 * impossible rather than merely unlikely". A screen cannot accidentally offer a download for something
 * that has no builder, because there is no property to call.
 */
export type SubmissionFormat = FormatCommon &
  (
    | { available: true; build: (p: SubmissionBuildInput) => Promise<SubmissionBuild> }
    | { available: false; unavailableReasonKey: string }
  );

/**
 * THE REGISTRY. One array; the screen and the download route both read it and neither holds a list of
 * its own.
 *
 * ⚠️ THREE FORMATS, NOT ONE, AND THAT IS WHY THE SEAM IS CREDIBLE. A registry validated against a single
 * format is not a registry — it is one function with extra ceremony, and its first real second format is
 * where the design is actually tested. All three below are wired to writers that already exist and are
 * already golden-tested; this round adds no new byte layout to the product.
 */
export const SUBMISSION_FORMATS: readonly SubmissionFormat[] = [
  /**
   * LHDN e-Data PCB (CP39) — the monthly tax-deduction submission file.
   *
   * ⚠️ READ THIS BEFORE CONCLUDING THIS ENTRY SHOULD NOT EXIST. The build brief for this round said to
   * list LHDN as "unavailable pending a real filed specimen" and NOT to write an LHDN writer. No LHDN
   * writer was written here — and none needed to be, because THE WRITER ALREADY EXISTS AND ALREADY SHIPS:
   * `localization/my/cp39-file.ts` (`buildCp39File` pure + `cp39FileForBatch` over the DB), reachable in
   * production today at `/payroll/reports/cp39-file` and linked from BOTH
   * `app/payroll/reports/page.tsx:148` and `app/payroll/statutory-forms/[formId]/page.tsx:358`.
   *
   * Marking it unavailable HERE would therefore not have withheld anything from anybody. It would have
   * created a screen that says "LHDN: not available" while the screen one menu row away hands over that
   * exact file — which is the r296 PERKESO defect (readiness item 3.1) repeated: two surfaces disagreeing
   * about one capability, with nothing on either saying which is right.
   *
   * WHAT IS HONESTLY TRUE of these bytes is `specification-sample`, and the screen prints it. The layout
   * comes from LHDN's published "Specification for MTD Calculations" Exhibit 4, and `test/slice0.test.ts`
   * drives the writer with Exhibit 5's worked example. ⚠️ BUT THAT TEST RECONSTRUCTS THE EXPECTED 136-
   * CHARACTER LINE FROM THE FIELD TABLE rather than comparing against a sample file — there is no
   * Exhibit-5 file in `test/fixtures/` — so the writer and its test are two transcriptions of one table,
   * which agree. No file from this system has been through e-PCB Plus, and `localization/my/cp39-file.ts`
   * flags even the line terminator as unconfirmed. That is a weaker claim than EPF's and SOCSO's, whose
   * tests assert equality with a document the customer really filed, and a stronger one than the bare
   * field tables that produced the wrong Borang A. Saying exactly which is the job this registry took on,
   * and the reporter's real filed PCB file is what would move this entry to `filed-file`.
   *
   * FIRST IN THE GOVERNMENT SHELF (`rank: 10`), as the brief asked.
   */
  {
    id: 'my.lhdn.cp39-edata',
    authority: 'LHDN',
    group: 'governmentStatutory',
    rank: 10,
    labelKey: 'lhdnCp39',
    descriptionKey: 'lhdnCp39Desc',
    periodKind: 'month',
    verification: 'specification-sample',
    /*
     * ⚠️ LISTED, NOT BUILT HERE — AND THE REASON IS THE PACK BOUNDARY, NOT A MISSING WRITER.
     *
     * The writer exists and ships: `localization/my/cp39-file.ts` (`buildCp39File` pure +
     * `cp39FileForBatch` over the DB), served today by `/payroll/reports/cp39-file`. Saying "not
     * available" would be the r296 defect — a screen denying a file that another screen one menu row
     * away hands over.
     *
     * But THIS module is generic. `cp39FileForBatch` is reached by naming `localization/my` directly,
     * which `test/country-pack-drift.test.ts` refuses for any file outside the audited debt allowlist —
     * and that allowlist only ever SHRINKS (ADR-0080 D1/D7). The two formats below do not have the
     * problem: `loadBorangAFile` / `loadBorang8AFile` ride `reportPreview`, and their own headers record
     * that "`app/` never names `localization/my`". The e-Data FILE has no such read, so wiring it here
     * would have meant adding debt to a ratchet designed to forbid exactly that.
     *
     * Fixing it properly means splitting `cp39FileForBatch` the way `loadBorangA` is split — a generic
     * DB read in `app/` over a pure pack-side builder — or moving the MY format entries behind the pack
     * surface beside `plannedForms`. Either is a statutory-file refactor and belongs in its own round
     * with its own checking (CLAUDE.md §8), not in a screen's integration.
     *
     * So the row is listed with its provenance, and points at the screen that genuinely serves it today.
     *
     * ── r340 (0d02d4a1) RE-READ THIS AND CONFIRMED IT, WITH THE MISSING STEP NAMED ─────────────────
     * The item was "build the e-Data PCB file"; the file was already correct field-by-field against
     * Exhibit 4, so the work was this row. It is still not flipped, and the reason is narrower than
     * "a refactor": the generic read this row needs has nowhere to CALL.
     *
     *   · `reportPreview(s, {reportId: 'my.cp39', …})` already returns every field the writer needs —
     *     `localization/my/reports.ts`'s `cp39()` puts `taxNo`, `ic`, `oldIc`, `passport`, `countryCode`,
     *     `employeeNo`, `pcb` and `cp38` on each row and the employer header on `meta.formHeader`. So the
     *     generic DB read of route (a) is genuinely available to `app/`, exactly as `loadBorangAFile`'s is.
     *   · What is NOT available is the PURE BUILDER. `buildBorangAFile` lives in `lib/`; `buildCp39File`
     *     lives in the pack, and nothing generic re-exports it. `CountryPack` (localization/country-pack.ts)
     *     declares `reports`, `plannedForms` and `statutoryLinks` but no payment-file member, and
     *     `ReportDef.outputs: ['…','file']` is a DISPLAY chip with no generator behind it — audited.
     *
     * So finishing this needs ONE of: a `paymentFormats` (or `cp39File`) member on `CountryPack` +
     * `localization/my/index.ts` (ADR-0080 D6, route (b)), or the pure builder re-homed in `lib/` beside
     * `kwsp-borang-a-file.ts` (route (a)). Both are outside this module, and the guard test that pins
     * `available: false` (test/payment-submission-module.test.ts, "LHDN is LISTED … NO builder") is the
     * third file that has to move in the same commit. `test/pack-drift-allowlist.json` is NOT one of them:
     * it only shrinks.
     */
    available: false,
    unavailableReasonKey: 'lhdnCp39Pending',
  },

  /**
   * EPF — the KWSP i-Akaun Borang A upload file (EPFORMA2).
   *
   * `filed-file`: the layout is read off `test/fixtures/kwsp-borang-a-epforma2.txt`, the EPFORMA2 file the
   * customer attached to cc74dcb2, and `test/kwsp-borang-a-file.test.ts` rebuilds that sample's fourteen
   * employees and asserts byte equality.
   *
   * WIRED TO `loadBorangAFile`, WHICH IS WHAT THE EXISTING SCREEN ALREADY DOWNLOADS. Not a second path to
   * the same file and not a reimplementation: the identical function `app/payroll/borang-a/file/route.ts`
   * calls, so this shelf and the Borang A review screen cannot hand over different bytes for one month.
   * `query` is passed straight through, so the format's per-generation inputs (`epfPeriod`, `code`,
   * `control`, `batch`) keep working from here exactly as they do there.
   */
  {
    id: 'my.epf.borang-a',
    authority: 'KWSP',
    group: 'governmentStatutory',
    rank: 20,
    labelKey: 'epfBorangA',
    descriptionKey: 'epfBorangADesc',
    periodKind: 'month',
    verification: 'filed-file',
    available: true,
    build: async ({ companyId, periodKey, query }) => {
      const loaded = await loadBorangAFile({ companyId, periodKey, query });
      if (!loaded.ok) return { ok: false, status: loaded.status, message: loaded.message };
      return {
        ok: true,
        // The name the Borang A route already hands over, from the one definition both now read. A shelf
        // that renamed the file would have an operator uploading a file they cannot match to a month.
        filename: borangAUploadFilename(loaded.form.employerRef, loaded.form.contributionPeriodKey),
        bytes: loaded.text,
        contentType: 'text/plain; charset=us-ascii',
      };
    },
  },

  /**
   * SOCSO + EIS — the PERKESO ASSIST portal upload file.
   *
   * `filed-file`: the layout is read off `test/fixtures/perkeso-brg8a.txt`, the BRG8A.txt the customer
   * attached to 18c1d92b, and `test/perkeso-socso-file.test.ts` asserts byte equality against it.
   *
   * WIRED TO `loadBorang8AFile`, the same function `app/payroll/borang-8a/file/route.ts` calls — and which
   * r296 made the ONE writer of this file after two writers were found emitting different bytes for the
   * same employees in the same month. A third path that rebuilt the file would reintroduce exactly that.
   * Which revision (v1.0 / v2.0 with SKBBK) is written stays decided by the contribution month inside
   * `perkesoLayoutForPeriod`, and by nothing on this shelf.
   */
  {
    id: 'my.socso.perkeso-assist',
    authority: 'PERKESO',
    group: 'governmentStatutory',
    rank: 30,
    labelKey: 'socsoPerkeso',
    descriptionKey: 'socsoPerkesoDesc',
    periodKind: 'month',
    verification: 'filed-file',
    available: true,
    build: async ({ companyId, periodKey, query }) => {
      const loaded = await loadBorang8AFile({ companyId, periodKey, query });
      if (!loaded.ok) return { ok: false, status: loaded.status, message: loaded.message };
      return {
        ok: true,
        // `perkesoUploadFilename` — the writer's own exported helper, which the existing PERKESO route
        // also calls. Not re-derived here: this shelf and that route must name one month's file alike.
        filename: perkesoUploadFilename(loaded.form.employerCode, loaded.form.contributionPeriodKey),
        bytes: loaded.text,
        contentType: 'text/plain; charset=us-ascii',
      };
    },
  },
];

/** One format by id, or undefined. The id comes off a URL, so an unknown one must resolve to nothing. */
export function submissionFormat(id: string): SubmissionFormat | undefined {
  return SUBMISSION_FORMATS.find((f) => f.id === id);
}

/**
 * The formats on one shelf, in declared order.
 *
 * SORTED BY `rank`, NEVER BY ARRAY POSITION, so adding an entry in the middle of the array above cannot
 * silently reorder a shelf an operator has learned.
 */
export function formatsInGroup(group: SubmissionGroupKey): SubmissionFormat[] {
  return SUBMISSION_FORMATS.filter((f) => f.group === group).sort((a, b) => a.rank - b.rank);
}

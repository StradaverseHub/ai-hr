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
 * ── NO ADR-0080 D1 DEVIATION IN THIS MODULE ANY MORE, AND THAT IS WHAT 0d02d4a1 BOUGHT ───────────
 * D1 says `app/` reaches a pack only through a generic seam, and all three entries below keep that
 * promise by three different doors, none of which names a pack: `loadBorangAFile` and `loadBorang8AFile`
 * ride `reportPreview`, and the LHDN e-Data FILE — which has no such read, because the read IS the pack's
 * — rides `CountryPack.paymentFiles` through `./pack-file`. For one round that third door did not exist,
 * so the LHDN row shipped UNAVAILABLE while `/payroll/reports` handed over the identical file; r340 built
 * the door rather than either allowlisting an import or assembling a second read of the same figures
 * beside the one that already files. Read `./pack-file`'s header for why the second read was the worse
 * of the two options: two producers of one government file is the r296 defect.
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
import { parseRunSelection } from '@/lib/payroll-run-selection';
import { loadPackPaymentFile } from './pack-file';

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
   *   'month-cycle' — the same, plus WHICH RUN of that month, EXACTLY ONE and REQUIRED. One payroll month
   *                   can hold a regular run, a bonus run and an advance with different payment dates
   *                   (ADR-0024 multi-cycle; `payroll_batch.run_seq` is the cycle's identity), so a file
   *                   that pays PEOPLE has to say which of them it pays.
   *   'month-runs'  — the same, plus WHICH RUNS, any number of them, ALL TICKED BY DEFAULT (r372, item
   *                   f022dd70). A statutory return is still one filing per month and the default is
   *                   still the whole month; this exists because an employer sometimes has to hand an
   *                   agency ONE run on its own — the catch-up run for somebody who was overlooked, or a
   *                   bonus run filed before month end.
   *
   * ⚠️ THE TWO CYCLE KINDS ARE NOT ONE KIND WITH A FLAG, AND MUST NOT BE MERGED. `'month-cycle'` is a
   * MANDATORY single choice for a file that MOVES MONEY: leaving it blank there would pay a whole month
   * from a button somebody pressed believing they had picked one run, so an empty list disables Download.
   * `'month-runs'` defaults to everything and its empty case is an ordinary "this month has no completed
   * payroll run" — refused by the builder in the operator's own words, not by a disabled button. Same
   * control, opposite failure-safe direction.
   *
   * ⚠️ NOTHING DECLARES `'month-cycle'` TODAY, AND THAT IS STILL THE HONEST STATE. The only file that
   * would need it is a bank salary payment file, and the `salary` shelf is deliberately empty — a bank
   * payment file moves real money and every bank's layout differs (see the header). The union carries it
   * so that the day such a format is added it declares `'month-cycle'` and the field appears with no
   * screen change.
   */
  periodKind: 'month' | 'month-cycle' | 'month-runs';
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
 * The LHDN e-Data PCB format id, stated ONCE: it is this row's `id` AND the key its employer's country pack
 * is asked for (`CountryPack.paymentFiles`). Two spellings of it would mean the screen offered a button
 * whose file the pack does not answer to, and the failure would be a 404 at download time rather than a
 * red test. `test/r340-cp39-payment-submission-download.test.ts` pins both sides of the seam to this value.
 */
const LHDN_CP39_EDATA = 'my.lhdn.cp39-edata';

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
   * Marking it unavailable here withheld nothing from anybody — it created a screen saying "LHDN: not
   * available" while the screen one menu row away handed over that exact file, which is the r296 PERKESO
   * defect (readiness item 3.1) repeated: two surfaces disagreeing about one capability, with nothing on
   * either saying which is right. 0d02d4a1 closed that gap; see the builder's own note below for how.
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
    id: LHDN_CP39_EDATA,
    authority: 'LHDN',
    group: 'governmentStatutory',
    rank: 10,
    labelKey: 'lhdnCp39',
    descriptionKey: 'lhdnCp39Desc',
    // r372 (item f022dd70) — the month, plus which of its payroll runs. Defaults to all of them, and
    // "all of them" sends NO run parameter, so an ordinary monthly submission takes the byte-identical
    // path it always has. See `periodKind` above.
    periodKind: 'month-runs',
    verification: 'specification-sample',
    available: true,
    /*
     * ⚠️ DOWNLOADABLE SINCE 0d02d4a1, AND WHAT CHANGED WAS THE DOOR — NOT THE FILE, NOT THE BYTES.
     *
     * For one round this entry was `available: false, unavailableReasonKey: 'lhdnCp39Pending'`, and the
     * reason was never a missing writer: the writer ships and is served today by `/payroll/reports`.
     * The reason was that THIS module is generic and had no honest way to ask a country pack for a file.
     * Listing the row as unavailable while another screen handed the same file over was the r296 defect
     * (two surfaces disagreeing about one capability), and allowlisting a pack import would have grown a
     * ratchet that only ever shrinks. So the round built the seam instead — see `./pack-file`.
     *
     * `loadPackPaymentFile` resolves the EMPLOYER'S jurisdiction and asks its pack for the file this id
     * names, through `CountryPack.paymentFiles` (ADR-0080 D6). Three consequences worth stating:
     *
     *   · NO NEW BYTE LAYOUT AND NO SECOND READ. The pack's builder is an adapter over the very function
     *     the shipped report route calls, so both surfaces emit one month's file identically — asserted as
     *     an EQUALITY between the two paths, never as a re-derivation, because two producers of one
     *     government file is the failure r296 spent a round undoing.
     *   · THE FILE NAME IS THE SPECIFICATION'S, FROM ITS ONE DEFINITION. `xxxxxxxxxxmm_yyyy.txt`, produced
     *     by the writer's own exported helper exactly as the two entries below use theirs.
     *   · THE PROVENANCE DID NOT MOVE. `specification-sample`, unchanged: reading a published field table
     *     more carefully is not the same evidence as a file the customer really filed, and making a row
     *     downloadable is not a reason to upgrade the claim printed beside it. The reporter's real filed
     *     PCB file is still what moves this to `filed-file`.
     *
     * An operator-fixable refusal (no LHDN E-number on the company, a missing tax number, an identity
     * number that will not fit its fixed-width box) comes back as a 422 carrying the pack's own sentence.
     */
    build: async ({ companyId, periodKey, query }) => {
      // r372 (item f022dd70) — the payroll-cycle selection, parsed by the SHARED parser rather than read
      // off the query here. The two entries below never touch it: their loaders hold the whole query and
      // parse it themselves, because they also read `epfPeriod`, `code`, `control` and `batch` off it.
      // This one has to, because `loadPackPaymentFile` crosses a pack seam that takes values, not a URL.
      const selection = parseRunSelection(query);
      if (!selection.ok) return { ok: false, status: 422, message: selection.reason };
      const loaded = await loadPackPaymentFile({
        companyId,
        periodKey,
        fileKey: LHDN_CP39_EDATA,
        runSeqs: selection.runSeqs,
      });
      if (!loaded.ok) return { ok: false, status: loaded.status, message: loaded.message };
      return {
        ok: true,
        filename: loaded.filename,
        bytes: loaded.bytes,
        contentType: loaded.contentType,
      };
    },
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
    periodKind: 'month-runs',
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
    periodKind: 'month-runs',
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

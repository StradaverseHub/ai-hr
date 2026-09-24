# ADR-0036 — Payslip PDF + template (#22)

Status: Accepted · 2026-06-23 · Consultant feedback #22 (High)

## Context

#22: *"No payslip template is available for selection, and the system is currently unable to generate
payslips."* The consultant wants: payslip **templates** + **PDF generation** + **email delivery** +
**password/encryption** + **A5 print**.

Today there is a payslip detail page (`/me/payslip/[id]`) with all the figures (earnings, statutory
deductions EPF/SOCSO/EIS/PCB, net, employer contributions) and a browser **Print** button — but no real
downloadable PDF and no formal payslip layout. The "PDF generation" + "password/encryption" asks imply a
**server-generated PDF**, not a browser print (you can't password-protect a browser print).

## Decision

Generate the payslip server-side as a real PDF and serve it from an RLS-gated route.

- **Library: `pdf-lib`** (pure JavaScript — no WASM/native deps, so no Next.js bundler friction, unlike
  `@react-pdf/renderer`; it also supports document encryption for the deferred password phase). A
  `renderPayslipPdf(data, labels)` function draws an **A5** payslip: company letterhead (legal name +
  registration no), the "PAYSLIP" title + pay period, the employee block (name + employee code), an
  earnings section, a statutory + other-deductions section, the highlighted **net pay**, and the
  employer-contributions section. Amounts are right-aligned, tabular RM.
- **Route: `GET /me/payslip/[payslipId]/pdf`** — resolves the session, reads `payslipDetail` (which is
  already RLS-gated to own-or-admin, so the route inherits ABAC for free: an employee can only fetch
  their own payslip, an admin any), renders the PDF, and streams it with
  `Content-Type: application/pdf` + `Content-Disposition: attachment; filename="payslip-<period>-<code>.pdf"`.
- **UI:** a **Download PDF** button on the payslip detail page (the Print button stays for quick on-screen
  printing). The same route is linkable from the admin payroll batch + the `/me` payslip list.
- **Labels are i18n'd** — the route resolves `getTranslations` and passes the localized labels into the
  renderer, so the PDF respects the viewer's locale (reusing the existing `me.payslip` namespace).

### Template selection

Phase 1 ships **one** clean A5 template. The renderer takes a `template` argument and the route is the
single seam, so adding selectable templates later (per-company letterhead/logo, alternate layouts) is a
local change — no re-architecture. A `company.payslip_template` column can drive selection when more than
one exists; not added now (YAGNI).

## Deferred (later phases)

- **Email delivery** — depends on the notification-channels work (ADR-0034); a payslip-ready email with
  the PDF attached is a clean follow-up once a channel exists.
- **Password / encryption** — `pdf-lib` can encrypt; the natural key is the employee's IC or a per-payslip
  password. Deferred so phase 1 stays focused on "generate a payslip at all".
- **Multiple selectable templates + company logo upload.**
- ~~**Full-Unicode names** — phase 1 uses the built-in Helvetica (WinAnsi), which covers Latin/romanized MY
  names (all demo employees + the overwhelming majority of real ones); names in non-Latin scripts are
  encode-guarded so they never crash the render. Embedding a Unicode font (Noto) is the follow-up.~~
  **DONE — see "Phase 2" below (5b2a7f0f, r334).**

## Phase 2 — the Unicode faces (5b2a7f0f, r334, 2026-09-24)

This ADR's own deferred item, closed. It is an amendment, not a new ADR: the decision being changed is
the one recorded above.

**The defect.** Helvetica is WinAnsi, and the last step of `safe()` in `lib/payslip-pdf.ts` folded every
codepoint outside Latin-1 to `?`. Measured over the 68 label strings `lib/payslip-pdf-strings.ts` resolves,
on main@fbe66e35: **zh 63, ta 63, th 63, vi 53 unprintable; en 0, ms 0.** A Chinese, Tamil or Thai payslip
was a page of question marks where its words belong. (The round's brief said "ms 10, en 0". That is the
count BEFORE `safe()`'s punctuation fold, and it is 7 in *both* — en and ms carry the same seven em dashes
and the fold handles all of them. Nothing about ms was ever Latin-1-bound.)

**Decisions.**

1. **One face per script, each covering Latin as well, chosen PER DRAWN STRING.** No Noto face covers
   Latin + Tamil + Thai + CJK, and pdf-lib draws one run with one font. The alternative to a both-covering
   face was splitting every run — and every *measurement*, since `wrap()` measures against the real font
   and the document's no-clipping property rests on that. Faces: Noto Sans (Latin/Vietnamese), Noto Sans
   Tamil, Noto Sans Thai, Noto Sans SC (Chinese, simplified and traditional). Resolution is per string,
   not per document, so an English payslip for an employee whose name is written in Chinese keeps its
   labels and its figures in Helvetica and reaches the CJK face only for the name.
2. **Loaded lazily, per document.** `payslipFaceScripts` reads the strings this payslip will draw. An
   en/ms payslip reads no font file, registers no fontkit and embeds nothing — and comes out
   **byte-for-byte** the document it was before this change. That is asserted, as three digests taken from
   main@fbe66e35, in `test/payslip-pdf-unicode.test.ts`.
3. **Subset per document** (`embedFont(bytes, { subset: true })`). Measured deltas against the same
   fixture: en +0, ms +0, **zh +53,361**, **ta +17,400**, **th +13,140**, **vi +13,955** bytes.
4. **`fontkit@1.9.0`, NOT `@pdf-lib/fontkit`.** pdf-lib's own README names the fork; the fork writes
   corrupt subsets. Its CFF output rendered as unrelated ASCII letters, its TrueType output lost most of
   its glyphs (the embedded stream will not parse at all), and Tamil threw
   `ReferenceError: regeneratorRuntime is not defined` from the Indic shaper. Upstream fontkit does all
   three correctly and exposes the same surface pdf-lib drives, at a cost of 14 lockfile packages.
   It is `serverExternalPackages` in `next.config.ts` because Turbopack bundles its ESM build, which
   imports an `@swc/helpers` export that no longer exists — that is a 500 on both PDF routes, and the
   vitest suite is green either way.
5. **Bold: real files for Latin/Tamil/Thai, folded to Regular for CJK.** A CJK Bold is another ~8 MB for
   the weight of four headings. Every FIGURE stays Helvetica-Bold, because amounts are ASCII.
6. **`safe()` is kept.** Its smart-quote/dash/ellipsis fold is what stops a typographic dash dragging in a
   font file, and is why ms never lost a string. Only its Latin-1 clamp became font-specific: text drawn in
   an embedded face is clamped to what that face carries, and a character no face carries still prints `?`
   — visibly, predictably, never as a throw.

**What this cost the layout.** A real translation is longer than a question mark. A box's total row puts a
caption and an amount on one baseline and neither wraps; Vietnamese's "TỔNG CHI PHÍ NGƯỜI SỬ DỤNG LAO ĐỘNG"
printed straight *through* "MYR 8,141.55". `fitSize` shrinks such a caption to clear the amount rather than
wrapping (the total band's height aligns the two columns) or clipping (nothing on this document ends in
dots). Found by rasterising the page — the extracted text of the overlapping document was perfectly correct.

**The other statutory PDFs inherit the old limit.** `lib/ea-pdf.ts`, `cp22-pdf.ts`, `cp39-form-pdf.ts`,
`borang-a-pdf.ts`, `borang-8a-pdf.ts`, `tp1-pdf.ts` and `tp3-pdf.ts` all draw with `StandardFonts.Helvetica`
and carry the same fold. They are unaffected **today** only because they are produced in en/ms alone
(`EA_LANGS = ['en','ms']`, `app/payroll/statutory-forms/ea/shared.ts`). The moment a third locale is added
to any of them, that form starts printing question marks, and `lib/payslip-pdf-fonts.ts` is the module to
reuse. Deliberately not changed in this round.

**Still English on the document, and no longer for a font reason.** `englishMonthYear` and
`englishLongDate` in `lib/payslip-pdf-strings.ts` were pinned to English *because* the font was Latin-1.
The faces can now draw all four scripts, so that constraint is gone; the dates stay English because
localizing them would change what every existing payslip says, which is a separate decision. Both
docblocks are corrected to say so rather than to keep citing a limit that no longer exists.

**Fonts on disk.** `assets/fonts/`, not `public/` — `public/` is served statically by Next and would put
6 MB of font on a public URL for no reader's benefit. Read server-side at render time through
`process.cwd()`, cached for the life of the process, exactly as `lib/cp22-template.ts` already reads the
CP22 artwork. Stored brotli-compressed and inflated with Node's built-in `zlib`: 6,759,154 bytes committed
against 9,964,568 inflated, largest single file 6,090,080. All four families are SIL OFL 1.1, redistributed
unaltered, licence and copyright in `assets/fonts/OFL.txt`.

## Consequences

- Employees and admins get a real, downloadable, formal payslip — the headline of #22 — without a heavy
  PDF/headless-browser dependency. The browser Print path still works for quick prints.
- The renderer is a pure function over the existing `payslipDetail` read, so it is unit-testable (assert a
  `%PDF` document of non-trivial size) and reused identically by every surface that links the route.

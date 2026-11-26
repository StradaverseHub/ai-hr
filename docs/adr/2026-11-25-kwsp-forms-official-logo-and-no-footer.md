# Borang A and BBCD: official logo from an owner-supplied file, no footer small print

Decision: the reporter approved board item 66175cd2 (plan revision 1) on 25 November 2026. The
implementation is on branch `claude/kwsp-forms-66175cd2`. Staging acceptance is a separate step.

This reverses the r407/r411 decision that the drawn Borang A and BBCD print no KWSP logo and say at the
foot of each page that the page is ours. The reporter asked for both forms to follow their KWSP
reference forms, with the logo and with nothing else at the foot.

- **Logo.** It is drawn only from `assets/kwsp/kwsp-logo.png`, an official file the owner supplies. The
  file must be a PNG whose shorter side is at least 300 px; see `assets/kwsp/README.md`. The renderers
  fit it into its box and keep its proportions. Without the file, the box is left blank and the layout
  does not change. The vendor reproduction in the reporter's references is never used, traced or
  redrawn. Those reference PDFs contain real personal data and are not stored in the repository.
- **Footer.** The provenance lines and our English translation of PERINGATAN are removed from Borang A
  and BBCD only. PERINGATAN itself, in Malay, stays. The provenance statement moves to the PDF metadata
  (Subject and Keywords), together with the payroll month. It also remains on the review screen beside
  the preview. The plain-text copy of Borang A is unchanged.
- **Fidelity.** It stays `agency-layout`. Both forms are still drawn by us on A4. There is no KWSP blank
  on disk, so the forms are not promoted to `official`.
- **Not affected.** Borang 8A, Borang 8B, SIP, CP39 and every calculation.

`EPF contributions (KWSP)` (`my.epf`) is off the shelf, the Open Form step and the Filing history
choice (`ReportDef.shelf: false`). It stays registered because its submission drives the suspended-tenant
statutory override, its id is in the audit form list and recorded generations still refer to it.

## Plan revision 2 (26 November 2026): the crest is committed from KWSP's own website

The reporter refuted revision 1 because the logo box printed empty: no owner file was ever supplied. They
approved revision 2 on 26 November 2026, and the owner approved downloading KWSP's files and committing the
crest to the repository.

- `assets/kwsp/kwsp-logo.png` is KWSP's round crest, cropped from the logo KWSP publishes at
  kwsp.gov.my. Its source, retrieval date and SHA-256 are in `assets/kwsp/README.md`. Nothing was traced or
  redrawn, and the vendor reproduction in the reporter's references is still not used.
- `KWSP_LOGO_MIN_PX` drops from 300 to 180 px. KWSP publishes its crest at 180 px; across the 0.78 inch box
  that prints at about 230 dpi. A larger official copy can replace the file without a code change.
- KWSP's current crest differs slightly from the vendor copy on the references (no lettering in the ring).
  The forms use KWSP's current mark.

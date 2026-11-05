# Approved payslip item labels: compatibility review

Feedback7de6fc4e requires the saved item code and description on the PDF as on Review.
The renderer therefore prints `PC0 · Allowance…` instead of the description alone.
The layout, font sizing and pagination rules themselves were not changed by this repair.

The actual historical PDFs from [baseline run41870516243](https://github.com/StradaverseHub/ai-hr/actions/runs/41870516243)
were compared with the actual candidate PDFs from [diagnostic run41870523876](https://github.com/StradaverseHub/ai-hr/actions/runs/41870523876).
The baseline run succeeded. The candidate diagnostic deliberately retained the original stale
visual pins and deduction decoder, and remains a failed run; its artifacts are observations,
not a qualification PASS.

Both registered and unregistered forty-line fixtures change from three pages to four.
The candidate places12,14,14 and0 earning items on the respective pages; the last page
contains net pay and contribution/year-to-date blocks. Every code PC0–PC39 and its complete
description appears once in order. All printed amounts match the historical fixture,
including the unchanged stored totals. This fixture comparison makes no independent claim
that the synthetic input's aggregate fields were calculated by payroll.

All candidate pages were rendered and visually inspected. Wrapped names stay within their
rows, item amounts remain aligned, continued headings and footers remain legible, and no
text extends outside the pages. The two plain and two logo document pins remain unchanged.
Only the two long-document pins and their independently observed four-page counts change;
ordered forty-code assertions prevent omissions or duplicate items.

The same diagnostic captured actual payroll-generated CP38 fixtures, their stored rows,
native read models and PDF input snapshots. The stamped and unstamped PDFs have identical
rendered text. The six printed deductions are715.00,29.75,11.90,136.70,450.00 and125.00,
which total1,468.35 exactly as stored. CP38 and `DB368 · Staff purchase` appear once each;
there is no duplicate generic residual. The previous fixed-label test decoder omitted
DB368. Its replacement reads every monetary row geometrically inside the drawn Deductions
box, preserving the original financial and legacy-equivalence assertions and additionally
pinning the named125.00 item and absence of a duplicate lump row. No payroll calculation,
stored amount or production PDF code changes in this compatibility repair.

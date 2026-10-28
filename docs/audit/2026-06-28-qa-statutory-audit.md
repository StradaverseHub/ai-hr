# ai-hr — Build Audit: Senior QA + Malaysian Statutory Practitioners

> Historical summary. Original observations apply only to their recorded source/date, not today.
> Full detail: `git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/audit/2026-06-28-qa-statutory-audit.md`. Verify current code and evidence before acting.

The June 2026 audit recorded 38 confirmed findings (2 critical, 9 high, 16 medium, 11 low). The titles below preserve the outstanding-risk search index, not their present resolution status. Reproduce against current services/tests and consult subsequent decisions before treating any as open or fixed. Original reasoning, examples and statutory citations remain in Git.

## Original finding index

- 1. Loan negative-net guard ignores CP38/TP1/zakat/unpaid — payslip net pay goes negative
- 2. Clamped loan instalments + duration-reached auto-settle silently writes off the outstanding balance
- 3. Leave working-day counter hardcodes Sat/Sun as the rest day, ignoring the configurable roster the attendance engine uses
- 4. OT 1.5/2.0/3.0x buckets are four manual RM inputs — no s.60A rate math is applied to them
- 5. Imported-history net-pay reconciliation omits zakat, so zakat-paying employees' valid rows are wrongly rejected (or force mis-coding)
- 6. Emergency-Leave partial split rounds fractional AL coverage UP into the ANNUAL child, creating a permanently-unapprovable request
- 7. sweepDueReviews re-opens a brand-new review every run after the prior review is completed
- 8. Clamped reservation overwrites the schedule row's dueAmount, corrupting the materialized repayment schedule
- 9. Loan auto-settles to zero balance after N instalments even when net-pay clamp left a balance outstanding — silent write-off
- 10. HOD department-tree visibility branch has no company clamp — cross-company employee disclosure via a cross-company department parent link
- 11. Amending a loan's duration silently erases its notes
- 12. Emergency Leave forces Annual-Leave shortfall to UNPAID without employee consent — likely an unlawful unilateral deduction
- 13. Maternity leave gated only on gender — missing the EA s.37 qualifying-service / multiple-child conditions
- 14. Replacement-leave (TOIL) lapse-without-pay path can breach the statutory OT-pay floor for First-Schedule employees if policy is misconfigured
- 15. Holiday resolver counts only fixed-date holidays; omitted Islamic/lunar/ruler-birthday gazetted holidays will mis-count leave and rest-day pay
- 16. No EA s.24 deduction-limit guard; net pay can go negative after loan/CP38
- 17. Manual OT buckets are not reconciled with the attendance-derived OT engine — last writer silently wins
- 18. EA-overwrite lets HR amend the MTD figure on the EA form independently of the CP39 already filed to LHDN, with no consistency note — annual EA vs monthly CP39 mismatch audit risk
- 19. closeReplacementLeaveYear reads company.leaveCycle with no WHERE filter, applying one company's cycle to the whole tenant
- 20. Hiring provisionalEndOn is never written to the review end-date columns, so auto-review never fires for new hires
- 21. REPLACEMENT consumption is gated on TOIL_ENABLED at approval time, decoupling the ledger debit from the register and enabling a later double-debit
- 22. Test asserts the clamp implementation (loanDeduction < 5000) instead of the requirement (net ≥ 0 under realistic deductions)
- 23. estimateNetBeforeLoan ignores all of its period parameters and uses a coarse 50%-of-gross floor
- 24. employee_loan / loan_repayment RLS WITH CHECK uses can_see_employment, so the SUBJECT can self-write their own loan ledger — no DB backstop for admin-only writes
- 25. Bulk-review toast prints ungrammatical English ('canceld') and is never translated
- 26. Feedback board omits 'rejected' status: chip counts don't sum to total, and rejected items can't be filtered
- 27. Analytics dynamic enum keys (gender_/marital_) can render raw key paths for free-text values
- 28. Bucket labels (2.0x rest day / 3.0x holiday) misstate the EA1955 rest-day and holiday OT formula
- 29. OT eligibility gate uses basic+allowance only and silently excludes >RM4,000 earners with no payslip note
- 30. Imported history is filed to CP39 verbatim, but the importer never validates that imported pcb/cp38 split is internally consistent or that TIN exists — silent CP39 mis-statement risk at year-end
- 31. EA Part B breakdown of imported gross collapses entirely into 'basic' when the file omits allowance/OT/bonus — EA line-items mis-stated although the EA total is right
- 32. TOIL convert-to-pay amounts use floating-point dollar math instead of integer cents
- 33. updateIndividualTxn/deleteIndividualTxn throw BatchNotDraftError when the row simply does not exist
- 34. CP38 supersede leaves a closed row whose month-aligned validTo still matches the boundary month (latent overlap)
- 35. Department tree recursion (heads_department_of) and the org subtree CTE are uncapped / cycle-unguarded
- 36. Test 'helpers are additive' asserts implementation booleans rather than the cross-company visibility requirement for partner person/employment reads
- 37. LoanList maps rows into an un-keyed Fragment (React key warning / reconciliation risk)
- 38. Single-series BarCharts color every bar a different palette color, contradicting the single legend label

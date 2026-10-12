# OneHR in native Performance

OneHR assessments use the existing HR login, employee records, company scope and reporting lines. Performance owns assessments; Rewards owns reward recommendations, approvals and pay posting.

## Set up a cycle

1. In **Performance**, create a draft cycle for the intended company and dates.
2. Open the draft and choose **Enable OneHR workflow**. Review the policy before opening the cycle.
3. Choose the assessment kind and enabled modules. Set the fourteen step windows in Malaysia time. Blank window boundaries leave that step open while its workflow allows it.
4. Review the leadership framework, technical profiles, grade weights and potential cutoffs. Download the assessment catalogue JSON to edit/import the actual approved catalogue (JSON smaller than 750 KB). Profiles can explicitly assign native employment IDs when several roles share a grade; otherwise one company/grade default must match.
5. Review each company's KPI mechanism and band cutoffs. Company achievement bands select Mechanism B; otherwise the company uses Mechanism A. Do not use source defaults as evidence of your organization's approved configuration.
6. Open the cycle. This snapshots the roster, grades and assigned statements and fixes the policy for that cycle.

## Complete assessments

Employees and assigned reviewers use **My Performance** to open their assessment tasks. Managers also see them in **Performance**.

- Employees draft KPIs whose weights total 100%, select the ordered line/matrix approval chain, and propose the whole scorecard. The manager approves or returns it.
- Employees submit actual results once. Each approver confirms the preceding result in order; changes require a reason. The final approver locks the KPI. The assigned manager then confirms the overall performance band.
- Employees answer their technical statements. The manager reviews them separately; changed answers require reasons.
- The manager assigns a panel using native reporting relationships. Numeric grades require the policy's valid-response minimum; the source default is four, with five recommended. Non-numeric grades use one line-manager assessment. An unsubmitted rater can decline or be replaced; submitted responses remain part of the assessment.
- Development plans are shared with the manager, discussed and closed, then acknowledged by the employee. Shared goal definitions stay fixed; progress remains updateable through the year. Year-end plans cover the next year; mid-year reviews use the current year.
- Evidence can remain private in draft or be shared. Correct shared text with a new entry. Endorsements/disputes and native attachments provide context; they do not calculate a rating.

## Calibrate, finalize and release

A Performance administrator assigns explicit reviewer cohorts and tiers. Performance and potential can be confirmed and locked separately. Unchanged bands can pass through a tier without an override. Changed bands require reasons. Group reviewers can lock individuals; a reviewer cannot calibrate their own assessment.

BG, Group or final reviewers explicitly confirm any PIP, promotion or special-reward nomination. These decisions are separate from the derived talent category.

Finalize each completed assessment to freeze its result and provenance. Release performance, potential, talent and anonymous 360 summaries separately. Releases can be revoked without changing the frozen assessment. Employees never receive intermediate calibration tiers or panel identities. Close the cycle after all assessments are finalized.

## Use the results in Rewards

1. Open the corresponding annual draft Rewards unit and its **Data** tab.
2. As Group Rewards, explicitly import finalized OneHR results. The import records the source result and digest and resets fact verification and earlier approvals. Development/evidence-only records are excluded; an unassessed axis retains the existing Rewards fact.
3. Review the imported classifications and nominations, complete case decisions and verify the facts.
4. Continue the existing Rewards recommendation, approval and posting process.

`PIP/Improvement` maps to Rewards **IMPRO**. Only an explicitly confirmed PIP decision maps to **PIP**. A promotion or special-reward nomination is supporting evidence for a human recommendation. Importing an assessment does not change salary or create a payroll input.

## Source limits

The package supplies source code and handoff documents, not live employee-history data or proof of the organization's active catalogue. No employee history is inferred or imported. The source's less-is-better Mechanism B excellence example and a later max-17.5 leadership framework require HR validation; source arithmetic and the supplied max-35 framework are retained explicitly. New UI keys exist in all six locale catalogues with English fallback pending translation.

AI assistance uses the native provider configuration. It selects only authorized existing passages, rechecks access and current evidence after the provider call, and requires the human to edit and use the suggestion. It cannot set ratings, nominations or pay.

Implementation decisions and source provenance: [ADR-0102](adr/0102-onehr-native-performance-and-rewards.md).

For a disposable local demo, run the normal demo seed followed by `node --env-file=.env.local --import tsx scripts/dev-fixture-onehr.ts`. The fixture refuses non-demo production/authentication settings and creates an isolated fictional company with a finalized assessment and an imported annual Rewards unit. It is not run by deployment.

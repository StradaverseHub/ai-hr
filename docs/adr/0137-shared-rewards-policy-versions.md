# ADR-0137 — Shared Rewards policy versions with independent reviews

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- Date: 2026-10-21
- Status: Approved direction, source implementation; execution and release pending.
- Board item: d0643736-28f1-49da-9211-d27330d8d70a, approved revision 1.

## Decision

A named shared configuration owns a versioned RewardPolicy and explicit company/business-unit
pairs for a reward year. A global business unit can be selected separately for each company;
selecting it for one company never selects another. Current setup compatibility and actual
company administration are checked when saving and when creating a review. The existing MYR
Rewards engine remains the calculation owner; shared configuration supports MYR companies.
It does not add currency conversion or share a company's monetary budget with another company.

Each annual review consumes one immutable configuration version at creation and copies its
policy into the existing review. Its roster, named senior membership, confidential membership,
funding, verification, approvals and calculations remain owned by that review. Existing reviews
never receive a later version automatically. Their company, business unit, annual kind, cycle and year cannot be reassigned under that lineage.
Their immutable origin remains visible, with an
indication when their own policy has subsequently been edited through the existing authorized
review policy flow. Off-cycle review inheritance is unchanged.

There is at most one current shared configuration for a company/business-unit/year pair. A
creator cannot ignore a current assignment or consume a superseded version. Changing the
assignment or policy requires a new version under the shared tenant access lock. An expected
revision prevents lost updates and stale review creation. A failed audit append rolls back the
head, immutable version and targets together. The audit contains configuration identities,
revision and digest, not salaries, employees or monetary policy content.

Removing all pairs from an existing configuration explicitly archives future assignment. It
retains every version, target, review binding and audit record. Authority for an empty head is
the latest non-empty version's full company scope, never an empty-set grant. Reassignment or
restoration requires all retained scope and all new company targets. An empty new configuration
is refused. Referenced companies and business units remain protected through the canonical
company-reference owner even after a target is retired.

The runtime cannot read or mutate the private version tables directly. Dedicated SQL owners
validate live login/actual role and scope with the existing Rewards administrator predicate.
Editing a multi-company configuration requires authority for its complete current scope and
all new pairs. A company administrator may consume its own assigned version without seeing
other companies' targets. Usage is a scoped list of linked reviews and versions; it includes
no employee roster, salary, executive confidential count or private membership. The normal
Rewards owner remains responsible for every linked review's authorization.

The existing policy editor and server form codec are reused. Shared policy always uses the
named senior-membership model; the shared editor never selects employees or copies legacy
grade rules. Unit-specific lump funding remains unset in a shared version. The pair picker
search preserves selected targets and changing actor, scope or revision discards the draft.
Save requires an explicit review of selected pairs; failed stale saves require a fresh version.

## Verification boundary

Migration 0580 at reserved timestamp 1791900000060 is a draft and is deliberately not journalled
or applied before verified ascending arrival of Board1's 0576/0577, ESS 0578 and Security 0579.
Source regressions are prepared for exact pairs, scope revocation, foreign references, version
concurrency, audit rollback, immutable lineage, archive/restore and editor interaction. None has
executed in this source phase because Board1 holds both test slots and the DB lease.

Before completion: verify the original reported journey against production; execute focused
consumer/model/SQL/DOM checks; inspect populated and approved review invariance, pay-free
configuration and confidential membership boundaries; demonstrate actual save/reopen, stale
and unavailable setup, six locales, keyboard and mobile behavior; run two independent populated
restricted-owner upgrades and the classifier-required gate and official Linux production build.
A source checkpoint or test count does not establish these outcomes or authorize board closure.

## Approved follow-up — 29 October 2026

Board requests 8ff065b3, 1acb9934 and 59b01b97 refine the original compatibility and ownership
rules. A catalogue's global availability or creation company is not evidence that a company
belongs to a business unit. New policy targets and review creation must follow actual effective,
unsuperseded People organisation assignments, using the assignment's dated company and the
existing legacy company fallback. Companies without a current relation show an explanation;
no relation is inferred from a label's name or its catalogue ownership. Existing target/version
records and review snapshots remain intact, with invalid retained selections shown for explicit
correction. The approved picker order is business group, business unit, then company, with the
selected pairs visible above the choices while scrolling.

Shared policy owns group rules. Unit PAT, target months, multiplier overrides, branch ratings,
exemptions and unit funding are omitted from shared presentation and from new-review consumption.
Historical stored versions are not rewritten. Their shared-view projections redact these unit
figures, including version comparisons; immutable version identity still records the new review's
origin. Origin comparison ignores unit-owned values so configuring a unit budget does not claim
that the shared group policy changed.

New grid saves validate complete H/JG12–23 bonus rows, complete salary ranges except JG23,
strict salary bounds and rating order, zero UA and supported decimal precision. Legacy snapshots
remain readable and must be corrected explicitly before a new configuration version is saved.
New configurations record eligibility facts explicitly. A version predating an active-as-of date
or a minimum bonus rating is labelled as legacy snapshot behavior or unspecified; summaries do
not invent those facts. These are implementation rules for the approved follow-up; installation
and acceptance still require the repository release evidence and a rendered authorized journey.

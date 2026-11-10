# Recruitment — integration architecture (IMPLEMENTATION DECISIONS)

Everything in this file describes how AI HR would host a Recruitment module. **None of it is a claim
about how the reference (Moka) works.** Reference behaviour belongs in `specification.md` and must be
traced to evidence.

## Where "Recruitment" mounts (repo rules, verified 2026-11-10 at `f07f32dcd`)

| Concern | Repo owner | What the Recruitment module needs |
| --- | --- | --- |
| Module shape | ADR-0080 D10/D11 (`docs/adr/0080-country-packs-as-installable-modules.md:281-297`) — recruitment is named explicitly | `packs/recruitment/index.ts` (client-safe `ModulePack` + `registerPack`), `packs/recruitment/service.ts` (server-only facade), import in `packs/register-all.ts`, drift test `test/recruitment-pack-drift.test.ts`. No imports from other packs (D9). |
| Sellable code | `packs/catalog.ts` `MODULE_CATALOG` (:86-184), seeded by `scripts/seed-catalogs.ts` | New row `recruitment` (`category:'hr'`, `dependsOn:['employees']`, `billable:true`, `packBacked:true`). |
| Default-off gate | `packs/catalog.ts` `LEGACY_MODULE_ENV_GATES` (:371) | A reserved, unset env name (e.g. `RECRUITMENT_ENABLED`). **Never `null`** — that grants the module to every tenant through the 0313 backfill. |
| Nav | `packs/registry.ts` `NavLinkDescriptor`; `components/sidebar.tsx` (`MODULE_OF_HREF` :224, `GROUPS` :398); `lib/navigation-workspaces.ts`; `lib/nav-entitlements.ts:34` | `{ group: 'manage', href: '/recruitment', labelKey: 'recruitment', icon: <lucide> }`, plus a workspace placement and the module code in `MODULE_CODES_WITH_NAV`. |
| Route gate | `lib/authz.ts:32` `requireModule` (fails open without a snapshot), `lib/scope.ts` `scopedSession` | Every page: `await requireModule('recruitment')` then scoped session; the service refuses independently. |
| Permissions | `lib/permissions.ts` `SCREENS` (:108); `core/product-context/capability-catalogue.ts` | One `ScreenEntry` per page; capability classification. |
| Recruiter role | ADR-0049 (`docs/adr/0049-job-function-partner-roles.md:25-66`) | "Recruiting Partner" ships **with** the ATS tables (enum values cannot be dropped): company-scoped grant, RLS helper `app.can_admin_recruitment_for(company)`, `hasGrantFor`-style gate, new `MATRIX_ROLES` row. |
| Job reference | `packs/job-descriptions`, `packs/job-architecture`, `position`, `job_grade` | A requisition/job opening references an approved JD revision or position through a kernel contract. |
| Hire → employee | Lifecycle/onboarding module | An accepted offer hands off to existing onboarding; PERSON/EMPLOYEE/EMPLOYMENT stay distinct, candidate ≠ employee until hire. |
| Labels | `messages/{en,ms,ta,th,vi,zh}.json` `nav.*` | Parity enforced by `test/i18n-coverage.test.ts`. |
| Data | `db/migrations` (latest `4202`, journal idx 3602), `docs/MIGRATION-ALLOCATION.md` | Reserve a block above the peer maximum; RLS + GRANTs on every new table. |

Tests that will police the slice: `test/function-access.test.ts`, `test/slice4-nav-gating.test.ts`
(add to `ROOTS`), `test/module-catalog-drift.test.ts`, `test/module-pack-registration.test.ts`,
`test/pack-registry.test.ts`, `test/navigation-workspaces.test.ts`,
`test/sidebar-workspace-inventory.test.ts`, `test/capability-catalogue-drift.test.ts`.

## Dependency map (target, uncertain until reference screens are observed)

```
Recruitment menu ─▶ /recruitment/* pages ─▶ requireModule + SCREENS guard
      └─▶ packs/recruitment/service.ts ─▶ (entities: UNKNOWN until observed)
                  ├─▶ kernel contract → job-descriptions / positions
                  └─▶ kernel contract → lifecycle onboarding (on hire)
```

## Not reproduced by design

- The vendor's own login (R-001): AI HR keeps embedded HR login/MFA (ADR-0117).
- Vendor branding, logo, artwork and marketing copy: not licensed for reuse.
- Third-party scripts on the reference page (Baidu analytics, NetEase captcha).

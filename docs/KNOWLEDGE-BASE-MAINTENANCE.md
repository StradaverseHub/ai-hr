# Maintaining the system knowledge base

The application publishes two separate catalogs:

- `content/guides/manifest.json`: tenant system articles, upserted by tenant and slug into `kb_document`. Employees, managers and HR administrators retain the existing audience clearance rules.
- `content/operator-guides/manifest.json`: installation guidance rendered in `/operator`, after its operator-grant and non-demo guards. These articles are never seeded into a customer library.

## Refreshing a deployment

`deploy/deploy.sh` refreshes system articles after migration and conditional initial/demo seeding, before restart. Existing customers therefore receive updated guidance on ordinary releases. New provisioning uses the same catalog inside its creation transaction.

To refresh an existing installation independently, from its application directory with the intended production environment:

```sh
node --env-file=.env.production --import tsx db/seed-guides.ts --all
```

For one explicitly chosen tenant, set `KB_SEED_TENANT_ID` to its UUID and omit `--all`. Providing both is refused. `pnpm kb:seed` remains a **development** shortcut using `.env.local` and the development tenant default; do not mistake it for a production refresh.

The command requires the owner/migration connection, validates the catalog before writes, updates each eligible tenant in a transaction and closes its connection. Re-running keeps document IDs and avoids duplicates. Its output reports refreshed articles and customer-owned slug collisions. A failure aborts the current tenant's transaction and the deployment does not proceed to restart; earlier tenants may already have completed and can safely be retried.

The reserved authentication-audit tenant is excluded. Suspended, closed and unknown-status tenants are skipped using the shared sweep-standing rule and reported as skipped. Refresh a reinstated tenant after its standing is restored.

Only an existing `is_system=true` article can be overwritten on a slug conflict. Company-authored articles and uploads are preserved. A customer-owned collision is reported and remains authoritative for that slug; resolve it deliberately rather than silently replacing the policy. System articles themselves are managed release content, including local edits made through their inline editor. Keep company policies in separate company-authored articles.

**Never run `db/seed.ts` to refresh documentation.** The demo seed can replace business data.

## Updating an article

1. Inspect the current page, actions, authorization and authoritative service. Historical ADRs and handoff entries can describe an earlier state; resolve discrepancies against working code.
2. Write instructions around the reader's task: prerequisites, navigation, steps, expected state, failure handling and permission boundaries. Avoid freezing statutory rates or bank/agency requirements into product guidance.
3. Update the article and its manifest title/audience/category. Keep the slug stable for existing links. Add new tenant articles to the tenant manifest and operator articles only to the operator manifest.
4. Check every local Markdown link against an implemented page. Do not add secrets, activation URLs, customer data or production credentials.
5. Review translations against the changed source, then run the catalog and refresh tests and the required repository gate. Verify the rendered operator guidance and tenant article view.
6. After release, verify the running source/build and refresh output, then inspect the target tenant's article. A source edit or local test is not proof of publication.

## Translation freshness

`content/guides/i18n/source-hashes.json` maps each guide slug and locale to the SHA-256 of the **reviewed English title + newline + trimmed English body**. `guideSourceHash()` in `lib/guide-catalog.ts` is the canonical calculation. A translated title and body are used only when that recorded hash matches; otherwise the refreshed database article uses the current English fallback.

After translating and reviewing a particular article, obtain its source hash from the application directory:

```sh
node --import tsx --input-type=module -e 'import { loadGuides, guideSourceHash } from "./lib/guide-catalog.ts"; for (const {meta,body} of loadGuides()) console.log(meta.slug, guideSourceHash(meta.title,body));'
```

Record the corresponding value under that article's locale only after reviewing both its localized title in `titles.json` and its `<slug>.<locale>.md` body. Do not stamp all old translations with new hashes to satisfy a check. The October 2026 refresh intentionally leaves the old translations unapproved; they remain on disk as translation source material. Operator article bodies are currently English, with localized section labels and an explicit language notice.

## Coverage and source map

| Guide area | Primary implementation to review |
| --- | --- |
| Setup, people, organization | `app/admin/organization`, `app/admin/personnel`, `app/personnel`, `core/org.ts` |
| Account activation, roles, audit | `app/admin/users`, `lib/identity`, `core/auth.ts`, `lib/authz.ts` |
| Leave and team availability | `app/leave`, `app/admin/leave-config`, `app/manage/my-team`, `packs/leave` |
| Clocking, corrections, roster, import | `app/attendance`, `app/roster`, `app/admin/attendance`, `packs/attendance` |
| Payroll, statutory outputs and payment | `app/payroll`, `packs/payroll`, current country pack services |
| Claims and loans | `app/claims`, `app/admin/claims`, `app/admin/loans`, `core/claims.ts` |
| Performance and goals | `app/performance`, `app/me/performance`, `packs/performance` |
| Lifecycle and equipment | `app/lifecycle`, `app/admin/lifecycle`, `packs/lifecycle` |
| Rewards and payroll posting | `app/rewards`, `app/admin/rewards`, `packs/rewards` |
| Mobile builder and live experience | `app/mobile-preview`, `core/mobile-design.ts`, `lib/mobile-design.ts` |
| AI, reports and operational tools | `app/control-tower`, `app/assistant`, `app/reports`, `app/analytics` |
| Notices and workflow email | `app/notices`, `app/admin/notice-board`, `app/me/notifications`, `app/admin/settings/notifications`, `core/notification-email.ts` |
| Operator provisioning and activation | `app/operator`, `core/operator.ts`, `db/provision.ts`, `scripts/provision-runner.ts` |
| Installation identity and email | `app/admin/settings/email`, `lib/identity/email-settings.ts`, deployment identity service |

The catalog intentionally explains optional modules without claiming they are enabled for every tenant. Features that require separate assignment, module entitlement or installation capability state that prerequisite in the article.

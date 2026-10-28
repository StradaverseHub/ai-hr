# AI HR

A multi-tenant HR application for people and organization records, leave, attendance, payroll, claims, performance, rewards and employee self-service. Tenant capabilities and installation configuration determine which journeys are available.

Start with [CLAUDE.md](CLAUDE.md) for development and [repository policy](docs/REPOSITORY-AND-ENVIRONMENTS.md) for branches/releases. Verify the actual checkout and remote freshness before editing; local branch names and old status documents do not establish current source.

## Development

Read `package.json` for supported runtimes and commands. Install with `pnpm install`; create a private `.env.local` from `.env.example` and configure disposable PostgreSQL using the current database scripts. Inspect targets before migration or seeding. The application role must be non-superuser and NOBYPASSRLS; migrations use a separate owner connection. Real worktree dependencies avoid external-symlink build failures.

Use focused tests during development and the repository gate/resource policy before release. A build is separate from tests and rendered acceptance. Bundled statutory behavior requires source/provenance review and appropriate sign-off; passing calculations do not establish filing acceptance.

## Source map

| Area | Source |
| --- | --- |
| Domain services and authorization | `core/`, `lib/` |
| Installable business/country modules | `packs/`, `localization/` |
| Web UI and routes | `app/`, `components/` |
| Schema, RLS and migrations | `db/` |
| Native employee application | [mobile](mobile/README.md) |
| Published tenant/operator guidance | `content/guides/`, `content/operator-guides/` |
| Verification | `test/`, `.github/ci/`, `scripts/` |

## References

- [Architecture decisions](docs/adr/README.md): decisions at their recorded date, with later amendments taking precedence.
- [Embedded authentication](deploy/internal-auth/README.md): approved login direction; legacy WorkOS/Keycloak adapters still exist. Runtime activation requires installation evidence.
- [Customer installation](deploy/CUSTOMER.md), [deployment](deploy/DEPLOY.md), [operator access](deploy/OPERATOR-ACCESS.md).
- [Documentation maintenance](docs/KNOWLEDGE-BASE-MAINTENANCE.md), [domain vocabulary](GLOSSARY.md), [product direction](PRODUCT.md).

Historical research, audits and handoffs are indexed summaries with Git recovery commands. They are not active task lists or proof of present deployment state.

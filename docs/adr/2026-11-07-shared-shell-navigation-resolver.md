# Shared shell navigation inventory and resolver

Status: accepted for the bounded extraction; verification is recorded with its frozen candidate.

## Context

The shell's declared rows and visibility policy lived inside the Sidebar client component. A future navigation coverage catalogue needs that same policy without depending on rendering or rebuilding a second authorization catalogue. Pack descriptors already own their rows; the shell additionally owns audience groups, special rows, and the composition of server-resolved capability facts.

## Decision

Move the declared shell inventory, row types, pack mounting, module mapping and static additional rows to `lib/navigation/shell-inventory.ts`. Move visibility composition and dynamic lifecycle/rewards destination assembly to the pure, client-safe `resolveShellNavigation` in `lib/navigation/shell-resolver.ts`. The resolver accepts existing `ShellNavigationFacts` and returns ordered `destinations`, V9 `lifecycleNavigation` metadata, and the same `canSeeChild` predicate used by the renderer. Sidebar consumes that result and re-exports `SIDEBAR_AUDIENCE_INVENTORY` for compatibility.

Preserve the current gate precedence, reference-sensitive Performance entitlement-before-cycle substitution, unresolved-versus-empty module snapshot behavior, explicit letter/rewards destination allowlists, request-bound inbox assignments, independent security capabilities and existing outer audience boundaries. Preserve the replacement of legacy onboarding presentation with V9 navigation and the separate scoped probation/contracts facts. Pack registration stays client-safe and pack service boundaries do not change. The same twelve scoped lifecycle descriptors are exported as `SCOPED_LIFECYCLE_NAVIGATION`, with module and access metadata; the resolver alone applies their existing page/configure/intake facts, without adding a global module gate.

Keep placement, first-occurrence deduplication, route ownership, workspace selection, focus, counts, command entries, translations and theme rendering with their existing owners. Disabled destination metadata survives resolution; Sidebar continues rendering those rows as non-links and excluding them from command entries and active ownership. The extraction adds no route or service authorization. Server guards and their capability resolvers remain authoritative.

## Consequences and limits

Consumers can inspect declared inventory or resolve the same shell policy without importing a React component. Source-inventory checks follow the actual extracted owner; render checks remain on the component. Focused parity cases exercise independently expected audiences, destinations and ordering, alongside existing DOM suites and the whole compiler on standard hosted Actions.

This first slice does not establish complete all-submenu coverage, a runtime performance improvement, authenticated page/service authorization coverage, or release/deployment acceptance. A later catalogue must consume these owners and name coverage gaps rather than inventing a second policy.

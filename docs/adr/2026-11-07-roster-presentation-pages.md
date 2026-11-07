# Roster presentation pages and explicit complete targets

Status: proposed, pending hosted qualification.

## Context

The grid already paged its DOM. The server still read the whole authorized employee list, hydrated every matching employee's roster/default schedule/holiday/leave window, built a complete workbook template and serialized those facts before that client pagination. The individual editor narrowed one employee only after loading the company employee list. Generate rendered all employees as native options; Copy rendered each target as a hidden input.

The Roster population is the legacy RLS employee read, including its current assignment (`valid_to IS NULL AND superseded_at IS NULL`), excluding employments whose termination date is on or before today's HR date. Future termination remains visible. Name/code search is ECMAScript trimmed lowercase substring matching, including Unicode, literal percent/underscore/backslash and surrogate behavior. Grid dates do not redefine this current employee population.

## Decision

Use the shared native employee-choice owner with trusted server-only `terminatedAfter` and optional exact employment IDs. Generic employee-choice transport cannot provide these authority/population controls. Native population filters, deterministic name/ID ordering, exact count and independent represented organisation facets precede the bounded employee projection. An explicit `All` keeps the existing shared 2,000-row ceiling with its visible truncation notice and complete export link; it uses one server population read rather than repeated 200-row count/facet scans.

The Roster presentation owner opens one enforced REPEATABLE READ / READ ONLY transaction and proves the actual calling principal. The shared employee port, bounded occupation/label projection and canonical roster/default shift/holiday/approved leave reads all use that same transaction. The transaction linearizes at snapshot admission; the next request observes committed authority/data changes. No cross-request authority or data cache and no Access advisory read barrier is introduced.

The full artifact reader remains the owner for explicit whole exports and workbook templates. The ordinary page ships only a template URL; clicking Download Template performs the complete authorized read. Cell resolution, domain writes, money, effective schedule calculations and export semantics remain with their existing owners.

Generate mounts 25 picker results and preserves individually selected IDs across searches/pages. Selecting all matching employees explicitly fetches complete minimal IDs, records that actual set and displays its count. One JSON field transports the set. Copy first prepares the complete set on demand, displays its actual count and requires another click to submit. It never resolves current filters at submission to silently include later arrivals. Submission refuses empty, malformed, duplicate, excess or no-longer-permitted prepared sets; existing canonical command admission still owns write authority and dependencies. The transport limit is 100,000 distinct canonical UUIDs / 4,000,002 UTF-8 bytes, refused rather than truncated. Existing department-precedence generation continues through the canonical department command.

## Verification

Hosted focused tests cover known stored/rest/usual cells against the full canonical reader; HR cutoff and future-ended membership; exact counts and past-end pages; represented facets; native company/foreign/manager/forged authority; one read snapshot across concurrent employment mutation; actual canonical SQL input bounds; progress behind an open Access writer; invalid date bounds before transaction admission; and a native 50,000-retained-employment component timing report (40,000 current Roster members by fixture design).

Rendered control tests cover bounded mounted results, persistent cross-page selection, complete 50,000-ID explicit selection without a proportional hidden-input DOM, empty/foreign/duplicate refusal, and later arrivals remaining outside a prepared Copy set. Existing template workbook-byte and grid render tests remain applicable. Focused/compiler/build evidence and staging acceptance are distinct from this source decision. Production remains held.

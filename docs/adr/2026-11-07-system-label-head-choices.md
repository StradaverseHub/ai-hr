# System Labels head identities load on demand

Status: proposed source; hosted qualification and browser verification pending.

## Evidence and decision

The original System Labels page unconditionally enumerated native-visible Employment
and Person identities before rendering any labels. The head reader borrowed the
5000-row label-maintenance limit and therefore refused a workforce of 5001 even when
the page had no configured heads. Frozen baseline commit
`0e7d2f22d9dfa10e675087e27b8f10b2fa7903ae`, hosted run `42380190578`, records that
actual fictional-data native failure observation. That checkpoint remains historical
evidence; the final suite replaces its failure expectation with a regression.

Initial rendering now reads only distinct configured Department and Business Unit
head IDs. With no configured IDs this port takes no database connection. The query
depends only on those two catalogues and runs alongside unrelated catalogue reads.
The existing 5000-label and complete-workbook contracts remain unchanged. Workforce
size no longer controls whether System Labels can render.

Explicitly opening a row's head browser requests at most 25 identities and an exact
total. The selected identity is resolved independently of page and search and can
be pinned alongside that page. The browser retains only the current page and current
selection. It never accumulates all visited employee labels or sends a workforce
DTO with the initial page.

## Preserved authority and business meaning

The domain population remains the original Employment/Person join by person ID and
tenant, native RLS, `app.is_admin()` and `app.is_admin_for(employment.company_id)`.
The requested company is the edited label's creation company, independent of the
workspace company switcher. Ended employments and employments without Assignments
remain valid choices. This is an identity browser, not the active-employment reader
used by some other screens.

Each port captures its caller inputs before awaiting admission. A fresh native
presentation-principal proof, native company scope and all identity reads execute
inside one read-only repeatable-read transaction. A one-company population first
restricts `employment.company_id` to the requested company, so its native
`app.is_admin_for` check is statement-constant; the multi-company retained-head read
keeps the per-employment-company predicate. No authority decision is cached across
requests. There is no Access configuration coordination lock or new write owner.

None still sends explicit null. A text-only rename still resends the retained head
unchanged. An inaccessible retained identity keeps its ID and displays the existing
unavailable label; it never becomes None or an exposed UUID label. Read-only label
rows keep their existing display. Canonical admin writers independently validate
same-company head IDs on Save. Criteria, dirty-row aggregation, copy/import and
workbook writes are unchanged.

## Search, transport and interaction

Code-first, then employment-ID ordering remains native and deterministic. Search
truth uses the shared `matchesEmployeeSearch` rule, including code separator folding
and JavaScript Unicode lowercasing. A conservative native candidate keeps all
non-ASCII rows; a read-only cursor fetches at most 512 candidates per batch and counts
every exact match while retaining only the requested 25. There is no hidden search
ceiling. The empty-query path uses a native exact count/page. Exact count and deep
offset work can still grow with population size; hosted timings must establish the
practical cost before claiming capacity or latency improvements.

The module-owned POST accepts only company ID, query, offset and optional selected ID.
It enforces same-origin browser transport, fresh admin authentication, UUIDs, bounded
offset/query/body size, duplicate-key rejection and private no-store responses.
Neither search text nor selected identity appears in new URL state. Fixed error
codes do not expose SQL or employee parameters. Framework redirects are rethrown.
Disconnects stop subsequent cursor work and release the transaction through the
existing read-signal owner.

The controlled chooser renders None and the retained head before hydration, then
loads only after explicit opening. It aborts obsolete requests and validates scope,
query, page and selection before accepting a response. Failures offer explicit retry
without discarding the draft. Existing six-locale employee-panel strings are reused.
The spreadsheet already uses a JavaScript-owned atomic Save handler; this repair
does not claim a new native no-JavaScript save flow.

## Qualification boundaries

The requested hosted checks cover actual native 5001-employee first/deep/ended and
no-Assignment cases, exact counts, current-principal revocation/archival, tenant and
company negatives, literal/Unicode/code-fold search, read-only enforcement, unrelated
Access writer coexistence and cursor cancellation. Transport, chooser and actual
server-page composition tests cover demand loading, bounded pages, race/retry,
useful server markup, current/None saves and unchanged label behavior. Related
criteria, global-scope, import and workbook regressions remain required.

No local application test, compiler, build or runtime has been executed. The affected
manifest requests hosted checks; it is not a pass receipt. The integration owner
must also verify an actual browser entry/search/deep-choice/Save journey, full
compiler/build and the relevant worker scenarios before release. The existing
all-module worker HTTP manifest omitted System Labels when this defect was found;
its coverage must be extended before claiming this path was load-tested. No staging
or production deployment, provider call, disclosure approval, schema or migration
change is authorized or performed by this source checkpoint.

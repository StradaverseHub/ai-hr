# Personnel organisation filters and private search

Approved feedback: 9c6b06d4-f8f4-4ef7-a083-3256bbd1da6c; full Business Unit labels from 0523730b.

The Personnel list, headcount and export use one validated query vocabulary and one predicate before pagination. Selected companies narrow the current Workforce purpose scope; they never become an authority claim. The native projection resolves the assignment applicable today, uses the reviewed organisation tagging owner, reads Job Grade codes independently of labels and displays full Business Unit names. A null parent remains a valid organisation root. Only the tagging owner's explicit pending state means the company is unresolved.

One POST search replaces the listing's profile-jump box and panel search. Every new term follows the private path, without guessing whether it looks like an identity number. The public bookmark/share view carries ordinary filters only. Legacy `q` remains a literal name/email/employee-code search and never gains identity matching.

The native comparison source admits only current Workforce companies. IC/passport values are projected into server memory only when the current company's identity-field permission allows them; they are not part of the Personnel list, client props, suggestions or any AI payload. The term is compared literally in authorized server memory and discarded. It is never written as a URL, SQL parameter, domain event or cache field.

The five-minute state stores only bounded matched employment IDs, public/identity match kind and native row revision evidence. A cryptographically random opaque token is returned; only its digest is stored. Tenant/current-login RLS binds the state, and the application role cannot directly select its matched-ID payload. Every list/count/export match rechecks current Workforce scope, identity permission for identity-only matches and the employment/person/statutory row revisions. Expired, borrowed, revoked or changed evidence fails closed. Oversized scoped populations refuse with a request to narrow company selection instead of silently truncating results.

The shared organisation quality owner defines missing BU, grade, superior and structure flags. Duplicate evidence follows the existing duplicate-person owner's normalized name plus hire date and distinct Person identities, over the permitted visible population only. Multiple employments of one Person are not suspected duplicates. Readers without the native administrative/identity evidence authority cannot acquire a duplicate flag or count from an inaccessible counterpart.

No employee re-tag or mapping activation is performed by this feature's migration or deployment. Legacy grouping is retained until the separately reviewed initial mapping publication.

## 2026-11-10 note: visible list search box and the Employee ID matching rule

Approved feedback: eaa7697c-da54-4727-b577-8dd754356ab9.

The listing again shows a "Search employee ID or name…" box beside Filter (`app/admin/personnel/list-search.tsx`). It is not a second search: it is another input for the same private term as the Filter dialog's employee-details field. It posts the complete criteria to the same route, receives the same five-minute principal-bound token, shares the same chip and request controller, and never places the term in a URL. Clearing the box posts an empty term with the remaining criteria, so only the search word is removed.

The private term's name and Employee ID comparison now uses the shared employee-search rule (`matchesEmployeeSearch` and `foldEmployeeCode` in `lib/employee-search.ts`), the same rule as the profile switcher. Case does not matter, and spaces, dots, underscores and dashes in an Employee ID are ignored, so "emp0008" finds "EMP-0008". This replaces "compared literally" above for those two public fields only. Work email remains a literal case-insensitive substring. IC and passport matching is unchanged: literal, except the existing complete-NRIC separator rule, and only under the current identity permission. Legacy `q` and the column "Emp ID contains" filter remain literal.

## 2026-11-11 note: suggestion dropdown and header filters

Approved feedback: aa045103-265b-4af9-86e9-ba7be9bf2081.

The listing search box shows up to eight suggestions while typing from the profile switcher's existing bounded reader (`GET /api/personnel/search`, the shared employee-search rule, the session's company scope, no exclusive Access lock). Suggestions never grant access and never narrow the list on their own: picking one applies that person's Employee ID as the private term, Enter applies the typed words, and emptying the box removes only the term. Typing alone no longer posts a private search.

The column header filters write the ordinary params the Filter dialog owns, never the private criteria: `companies`, `bu`, `dept`, `position`, `grade`, `type` and `bucket` are multi-select (any of), and `__blank` means "Blank / unassigned" for Business Unit, Department, Position, Job Grade and Employment Type, combinable with chosen values. Join Date, Group Join Date and Confirmation Date take inclusive From/To ranges (`joinedFrom/To`, `hiredFrom/To`, `confirmedFrom/To`). Every change drops `page`. The reader evaluates them in the same single predicate (`employeeListWhere`/`workforceListWhere`) on the typed projections, so the list, headcount and export stay one parse and one predicate. Free-text columns keep the private type-to-filter path.

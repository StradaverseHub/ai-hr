# Personnel organisation filters and private search

Approved feedback: 9c6b06d4-f8f4-4ef7-a083-3256bbd1da6c; full Business Unit labels from 0523730b.

The Personnel list, headcount and export use one validated query vocabulary and one predicate before pagination. Selected companies narrow the current Workforce purpose scope; they never become an authority claim. The native projection resolves the assignment applicable today, uses the reviewed organisation tagging owner, reads Job Grade codes independently of labels and displays full Business Unit names. A null parent remains a valid organisation root. Only the tagging owner's explicit pending state means the company is unresolved.

One POST search replaces the listing's profile-jump box and panel search. Every new term follows the private path, without guessing whether it looks like an identity number. The public bookmark/share view carries ordinary filters only. Legacy `q` remains a literal name/email/employee-code search and never gains identity matching.

The native comparison source admits only current Workforce companies. IC/passport values are projected into server memory only when the current company's identity-field permission allows them; they are not part of the Personnel list, client props, suggestions or any AI payload. The term is compared literally in authorized server memory and discarded. It is never written as a URL, SQL parameter, domain event or cache field.

The five-minute state stores only bounded matched employment IDs, public/identity match kind and native row revision evidence. A cryptographically random opaque token is returned; only its digest is stored. Tenant/current-login RLS binds the state, and the application role cannot directly select its matched-ID payload. Every list/count/export match rechecks current Workforce scope, identity permission for identity-only matches and the employment/person/statutory row revisions. Expired, borrowed, revoked or changed evidence fails closed. Oversized scoped populations refuse with a request to narrow company selection instead of silently truncating results.

The shared organisation quality owner defines missing BU, grade, superior and structure flags. Duplicate evidence follows the existing duplicate-person owner's normalized name plus hire date and distinct Person identities, over the permitted visible population only. Multiple employments of one Person are not suspected duplicates. Readers without the native administrative/identity evidence authority cannot acquire a duplicate flag or count from an inaccessible counterpart.

No employee re-tag or mapping activation is performed by this feature's migration or deployment. Legacy grouping is retained until the separately reviewed initial mapping publication.

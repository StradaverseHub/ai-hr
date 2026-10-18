# My Profile: Request to Edit

Approved cf588903 replaces the separate Request A Change forms with one **Request to Edit** course.
The employee's own Personnel summary and eleven applicable tabs share the canonical field names,
choices and recorded facts. Attendance clocking stays under My Attendance; My Profile has no Today card.

Click Request to Edit, change permitted fields across tabs, then Save once. View Only fields stay
visible without an editable control. Save submits touched fields only; omitted fields remain unchanged,
and clearing is validated explicitly. Cancel and no-op Save perform no mutation. Failed saves retain
input and return safe messages without internal database details. Leaving with unsaved input asks first.

Contacts can save immediately; other permitted changes wait for the existing HR approval workflow.
One transaction composes both outcomes, so a late failure cannot leave only part of the submission saved.
The result names the saved and waiting fields. Pending values are separate from master facts and never
replace them in the record or AI context. Bank and government identity values stay masked on the employee
view, including pending proposals. Existing decisions and rejection reasons remain available in Others.

Family, Qualification and Emergency Contact requests carry exact canonical register IDs, or an explicit
new-record identity. HR approval rechecks membership, current values, choices and permission. Primary,
Highest and child-relief effects use existing owner operations. Approval does not silently select a
different record when the original has changed or been archived. Both queues show current/requested
values and the target register context. Rejection requires a reason; nobody approves their own request.

Canonical Permanent/Correspondence addresses are the common record. Legacy-only/conflicting addresses
remain read-only reconciliation evidence for HR; they are not copied or dropped automatically. Unsupported
country-pack information is explicitly unavailable. Payroll, released employee documents, Leave and
Attendance retain their existing module, visibility and owner protections; the HR repository is excluded.

Legacy compatibility is intentionally finite. The original request declaration contains **twenty-four**
fields: **seventeen on the Profile tab and seven on Bank & Statutory**. Existing payloads and decisions
remain readable. Legacy `all` and lists control that original request set, while preserving the old finite
contact/current-primary rights. New complete policy saves use `{version:2,fields:[...]}` in the same
setting; its empty list denies every edit. Newly supported fields start View Only until Admin enables them.

Implementation acceptance still requires coordinated type/security/database checks and actual journeys
covering own employee, manager-own, scoped HR, group HR, foreign/invalid selections, multiple employments,
leavers, pending/approve/reject, failure rollback, all six locales, themes, narrow screens and keyboard use.
No source-only checkpoint is a claim that those journeys passed.

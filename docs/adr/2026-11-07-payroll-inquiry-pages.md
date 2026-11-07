# Payroll inquiry rows are paged before transport

Status: candidate; native and rendered qualification pending. Production held.

Fixed and Individual Transaction View now fetch the selected page and exact full-filter
count in one PostgreSQL statement. Both remain Read Committed under the existing Payroll
history shared barrier; no snapshot is pinned before waiting on that barrier. The single
statement prevents a count/page mismatch from a concurrent transaction commit. An empty
or past-end page retains its true count. “All” retains the shared 2,000-row ceiling and
visible truncation contract. Native scope, period, component, department, creator, date
and status predicates precede LIMIT; an empty company scope remains fail-closed.

The Individual reprocess predicate is a SQL twin of the canonical pure row rule: only a
processed batch with no employee payslip or a transaction changed after that payslip is
pending reprocessing. Native tests must prove processed/reprocess membership before
paging. Legacy readers and CSV exports retain their complete populations and audit path.
Amounts and descriptive quantities are serialized as decimal strings, including valid
numeric(12,2) boundary cents. No currency, payroll calculation or stored amount changes.

Column sorting applies to the entire filtered set before paging. Default period order,
dates, kinds, displayed statuses and decimal values retain their intended comparison.
Text headers explicitly use PostgreSQL lower-case values with C ordering and stable IDs.
This replaces browser JavaScript lowercase/UTF-16 order, not financial or filter logic.
A concrete difference: a BMP fullwidth Latin A sorts before an astral Deseret letter under
C byte order; the former JavaScript UTF-16 comparator placed the astral letter first.
Context-sensitive or newly added Unicode case conversions can also differ from the
browser's Unicode version. Native Unicode tests pin this visible ordering distinction
while requiring identical IDs and counts. No claim of exact old Unicode comparator
parity is made. Preserving the history contract takes precedence over introducing an
unqualified Repeatable Read fallback solely to reproduce a browser sort.

The employee rail is being moved separately to the shared bounded employee-choice port.
Its selected employment must be validated independently from its current search page;
all existing filters and authorized employees must remain reachable.

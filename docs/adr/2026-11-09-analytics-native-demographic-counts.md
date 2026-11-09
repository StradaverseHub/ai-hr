# Count Analytics demographic values in PostgreSQL

The native 50,000-employee dashboard run transferred 40,000 demographic rows
to JavaScript. That statement took 386 ms of the 3.47-second dashboard
observation. The same native scope and joins now supply one grouped statement
for all seven dimensions and the overall count. The 40,000 active employees
in that fixture have one raw value per dimension, so the expected transfer
is eight rows. Native verification must confirm the count and measure the
new query on the same fixture.

PostgreSQL groups the raw keys by bytewise equality. JavaScript retains the
existing null buckets and age calculation, including the combination of
different birth dates that fall in the same age band. Counts still sort
largest first and age bands retain their fixed order. Equal count ties had
no defined order in the original query. The original tenant, company,
permission, assignment and date predicates apply before grouping.

The standalone, composed dashboard and native JIT checks exercise the same
grouped statement. Retain the earlier per-employee statement and timings at
their original source and run identities.

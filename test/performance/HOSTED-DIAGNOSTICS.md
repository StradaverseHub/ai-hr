# Hosted performance diagnostics

Files named `*.hosted-diagnostic.ts` are measurement diagnostics that run only on a hosted runner selected by a focused
controller. The v17 release gate batches every `test/**/*.test.ts` file and refuses skipped tests, and these files skip
outside that selection, so they are kept out of the gate's suite by name. They are preserved unchanged for the separate
CI-controller project that will give them a dedicated hosted lane (see `claude/v21-ci-lineage-preserved-20261111`).

Their last recorded results are the release's performance evidence; they are not release gates.

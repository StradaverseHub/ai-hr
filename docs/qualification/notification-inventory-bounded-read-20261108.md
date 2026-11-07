# Hard-bounded diagnostic descriptor reads

Unexecuted source successor of `d98e758aa3f0c84464fbd8ef037b60fd874ec9ba`.
Both frozen inventory/registration parents remain unchanged. No hosted checks
were dispatched against either before this source correction. Production held.

Self-review found that `inventoryRegularBytes` checked the original descriptor
size, then called `readFileSync(fd)`. Final size/inode/time/Git-blob checks would
refuse changed evidence, but a concurrent growing file could consume more than
the declared read bound before that refusal. This was a resource-bound gap,
not proof that altered source could pass the final binding checks.

The actual reader now allocates only **original size plus one byte**, after
checking a safe integer expected size and the unchanged maximum. `readSync`
cannot consume beyond that buffer. An extra byte or an early EOF refuses; exact
size still needs all original descriptor/path size, inode, device, timestamp,
mode/link/ownership and immutable Git-blob checks. Zero-byte native evidence
remains refused by the outer regular-file owner. File limits remain16MiB,
source-file reads4MiB, singleton receipt1MiB and role receipt32KiB.

One new actual-descriptor model opens a real file at its original size and
grows it through a second descriptor. The reader refuses after original-size+1;
another real read confirms the appended file was not consumed to EOF. A real
truncate tests short-read refusal; exact and empty descriptors test EOF; invalid
limits refuse before reading, with an unchanged first byte proving no IO. The
five existing representation models remain unchanged, giving **six** prospective
models. None has run locally or hosted for this successor.

The native catalogue query, RR/RO session, full source/journal/ledger/receipt/
role comparison, normalization, private exclusive publication and all30s/20s/
300ms/2s case/SQL/lock/connect limits remain unchanged. No SQL, migrations,
recipes, worker profile, registry, policy, workflow, grants or admission changes.
The19-file singleton registry/20-owner closure and existing request cap16 remain.

Root and independent review precede hosted controller controls, six pure models
and the sole real full-CI inventory commissioning. The result remains diagnostic
only; no observed inventory, file count, pure pass or receipt can authorize a
native expected profile, worker adoption or release.

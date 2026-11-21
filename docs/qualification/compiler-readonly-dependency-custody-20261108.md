# Compiler miniature: read-only dependency custody

Native run42452778349 at7c6d847abdc44a49db179e1c848cea06e63661a3 failed in inventory.
Authenticated artifact13606174159, SHA256
2d9d24a2dd56fc468f7e1ab3e57ba338473c49ac884ec5ff0851ccc289742ad6, captured the
actual refused file facts: regular=true, symlink=false, native link count2,
218439 bytes against the unchanged536870912-byte cap. The single-link condition
was the failing conjunct. The particular filename was not captured. All twelve
later native phases remained blocked. Preserve this and the original afdf failure.

Input observations and exclusive owned output custody have different lifetimes.
The native TypeScript Program now chooses the read-only input reader only for
files it actually marks external/default-library, physically inside the canonical
candidate node_modules tree. Configured roots, the private fixture source tree
and every sealed owned output are excluded before this choice. A symlink or
external node_modules root is refused. Everything else still uses regularHash.

The new dependencyInputHash requires the exact SHA256 of the bytes the native
Program loaded, canonical containment and a bounded regular file, including an empty declaration. It
opens O_RDONLY|O_NOFOLLOW|O_NONBLOCK, hashes through the actual descriptor in
64KiB pieces, requires exact size and EOF, and compares device/inode/mode/UID/GID/
link count/size/mtimeNs/ctimeNs before open, on the open descriptor, after reading
and at the final named path. It rechecks the canonical directory identity and
path. Multiple stable hard links grant no write, mutation or disposal authority.
This is cooperative hosted source custody, not a hostile-runner sandbox proof.

The original regularHash, assertOutputSeal, emittedTree and artifact-budget
functions remain byte-identical. Native emission/config/fixture/output seals
still require one link. Reference inspection and declaration validation also
recheck their complete owned seals after the native inspection/semantic work.
No dependency file is copied, rewritten, unlinked or relabeled as an owned output.
The pinned compiler API/CLI hashes, native default host/resolver, options, complete
configured roots, semantic targets, original five miniature API negatives and
all13 planned native phases stay unchanged. The whole application compiler and
its original five application API negatives remain separate open obligations.

Four additional actual filesystem/source controls retain all23 original models:
stable hard-linked dependency input versus the same inode's strict output
refusal; outside/symlink input and symlink-root refusal; real alias content drift
against loaded-byte SHA followed by restoration; exact byte bounds and source
selection exclusions. The final case also proves four complete predecessor source
inverses. These27 controls do not qualify a compiler or concurrency race; no
concurrent mid-read mutation experiment is claimed. The strict before/after native
metadata checks are source-reviewed, with actual complete compiler phases required.

After root and independent review, run only the27-control wrapper on a standard
hosted runner; run the13-phase miniature only after controls pass and authenticate.
Retain earlier process12, adapter7, kernel17 and graph23 results under their actual
sources; do not rerun unchanged ownership kernels. No local behavior ran. The
12GiB heap,720-second aggregate window,848-second supervisor envelope and every
job/cleanup limit are unchanged. No app, database, provider, deployment or approval
manifest change is included. Staging and production remain held.

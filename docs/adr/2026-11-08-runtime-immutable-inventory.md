# Shared immutable runtime byte inventory

Status: first source slice, **unqualified and not installed**. Base is
`71949d41dde598a894dffefb47d78601d32c6c78`. Production remains held; all six
architecture gates still precede staging. This primitive does not admit a worker.

## Existing contracts and ownership

`.github/ci/build-bundle.py` already transports bounded format2 Next build bytes,
binds the exact sharp/fontkit external packages, normalizes the known Sharp0.35.5
semver wrapper, verifies receiver packages and reconstructs duplicates as separate
regular files. `scripts/releases/approve_staging.py` independently checks archive
private/cache/link rules and rebases only those two known CI build aliases before
private release publication. Neither path grants a new installation authority.

Both now use `.github/ci/runtime_inventory.py`. It owns descriptor-relative reads,
in-root dependency-link resolution, the two-package alias rule, package-tree identity,
and the extracted existing release archive audit/alias conversion. Consumers load
only the fixed repository-relative file with an explicit importlib location; no
application import, ambient PYTHONPATH lookup or executable runtime package is used.
The two cache controller implementation inventories bind the new file as well as
the original bundle owner. Missing/changed implementation blobs refuse old state;
no historical cache witness receives a waiver or new acceptance label.

Build-bundle retains format2 shape, capacity profile4, USTAR payload selection,
canonical JSON, gzip level9/header, content/mode deduplication, manifest hashes and
receiver reconstruction. Approval retains its existing acceptance, source/service
snapshot, publication, archive labels and alias tar conversion. No CD/SSH, schema,
app permission, provider, deployment grant, ready profile or runtime socket changes.

## Descriptor and link boundaries

`PinnedTree` opens every canonical root ancestor with directory descriptors and
O_NOFOLLOW, checks the opened inode against observed metadata, and retains the
ancestry pins. Child directories and files open relative to those descriptors.
Regular files are classified and bounded before opening; O_NOFOLLOW plus NONBLOCK
refuses a raced link/FIFO, then fstat proves the opened inode before payload reads.
Reads compare device/inode/size/mtime/ctime and repeat file, directory and link
identity proofs before returning a snapshot. Namespace arrivals/replacements and
post-read mutation refuse. An existing primary failure retains its cause; final
identity failures add a bounded note and do not trigger destructive cleanup.

Dependency links are resolved explicitly within canonical node_modules, at most100
hops, without OS traversal of an arbitrary symlink target. Absolute links already
inside that root remain supported for existing format2 producers/fixtures; they
authorize no other root. Relative pnpm chains retain real symlink/`..` semantics:
the unresolved suffix is never collapsed with normpath before resolving a package.
Inside the selected external package, the existing no-symlink contract remains.
Only a sharp/fontkit build alias with its existing hexadecimal suffix may resolve
to that exact package. Unknown aliases, cross-package targets and outside paths
refuse. No global runtime `secure_path` exception or general symlink grant is added.

Existing file/byte limits remain:40k build files/directories,2GiB build bytes,
256MiB member,32MiB external package/2000 package files,256KiB package manifest,
500k release archive entries and8GiB archive regular-file total. Additional
fail-closed metadata bounds are128 relative path components,20k external-package
entries including directories, bounded directory-name collection and9GiB compressed
archive input. These reject hostile metadata/path topologies; they do not increase
format2 capacities. A root cache symlink refuses. The active verifier still allows
only its existing explicit real/private generated cache directory and hashes every
compiled file; it does not invent shared cache semantics.

The release archive graph/audit rules are extracted, not redefined as a new general
untrusted archive format. Existing relative pnpm links, hardlink treatment, private
names, runtime roots, cache exclusions, build/lock/prerender gates and refusal text
remain. The archive is read through a pinned regular-file descriptor and its input
identity is checked after reading. Future managed release artifacts must separately
define their complete link/metadata/ownership/install protocol; this extraction is
not an assertion that legacy archive policy proves a protected immutable runtime.

## Prepared parity and failure proof

Frozen pre-extraction inventory scripts under
`.github/ci/fixtures/runtime-inventory-format2/` are comparison-only historical
fixtures. The build fixture is the exact complete predecessor. The approval fixture is its exact inventory-only source prefix, ending before staged_source; publication/CLI code is intentionally absent. The complete original approval script SHA256 is299fd3fa7c6c366b7b6ad5102ca75d05bd0152f026108750f87ef03e486d7cc4. Fixture byte hashes are pinned before import:

| Script | SHA256 |
| --- | --- |
| build-bundle.py |59ea07f197164943e2c487fa097bfb2b55a9b2622d5d29e5e6859116623a0caa |
| approve_staging.py |fdca8d8576e1fc0f81999aeb0c31e9b9a7345e1ea2bf9ea505aa3a53e1818b9d |

Prepared hosted tests compare old/new full scan results, package identities,
entire format2 manifest and gzip archive bytes, and both installed verification
results on the same fixture. Separate Sharp0.35.5 cases compare the old/new producer
and receiver hashes across origin rebasing and equivalent resolved semver spellings.
Publisher tests compare complete decompressed tar wire and every original file hash;
its existing gzip header behavior is preserved rather than falsely called reproducible.

Negative controls cover pnpm escape/cycle/dangling/internal links, alias targets,
ancestor/root/last-component replacement, special files without payload reads,
in-place/post-read file mutation, namespace arrival, entry/hop bounds, archive
private/cache/cycle/duplicate refusals and historical hardlink behavior. A subprocess
uses unrelated CWD, hostile PYTHONPATH and Python isolated mode to prove the fixed
inventory loader. Cache verifier tests require the actual new implementation blob
and refuse missing or changed content. These are tooling fixtures, not native Next
or application/browser qualification. No checks have run on this source yet.

## Remaining runtime adoption gates

The primitive does not make an app-owned directory immutable after verification.
A protected installer must bind ownership, modes, complete inventory, runtime Node,
private environment, permitted native dependencies and actual process/mount view.
The existing no-symlink ready profile remains unchanged and cannot yet adopt stock
pnpm Next layout from this module alone. Real stock Next startup, Sharp/fontkit/CJK,
read-only code with precisely owned writable caches and repeated ready identity
proofs need their own native tests.

Then qualify source/build/release generations, action/encryption/skew and old asset
routing, schema/job compatibility and rollback after new writes. Preserve every raw
bind, process-family, proxy-reader, cooling and no-POST-replay barrier. The protected
systemd/Nginx performance path and browser/module/2-4-8 worker gates are subsequent
work. No speed, zero Busy, all-six completion, staging or production claim follows
from inventory source/parity review.

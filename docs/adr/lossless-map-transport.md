# Lossless source-map transport

**Status:** Proposed for isolated qualification; canonical release admission unchanged
**Date:** 2026-11-02
**Deciders:** Repository owner and release-controller maintainers

## Context

The production build contains large, byte-identical source maps at distinct runtime
paths. Removing maps or their source content would change debugging. Gzip's small
history cannot eliminate repetitions across large files. Existing format2 readers
accept only ordinary, individually transported files and must continue to fail closed.

## Decision

Qualify an explicit format3 `next-map-byte-bundle` with a separate producer and
receiver. Keep the complete logical file inventory, modes, hashes, directories,
runtime aliases and build ID. Only duplicate `.map` bodies are omitted from the TAR.
The canonical first map for each size/hash is transported as a regular file.

Derive `mapCopies` from the validated, path-sorted inventory. Require the supplied
table to match that derivation exactly. References cannot form chains, cycles,
forward references, arbitrary aliases or non-map deduplication. Logical file and
unpacked-byte limits include every reconstructed copy; compression grants no extra
capacity. TAR headers remain regular-only, with existing bounded path, identity,
padding, inventory and digest checks.

Create copies with exclusive writes under a newly owned destination. Never hardlink
or symlink a map. Check donor bytes, destination readback, independent inode, size
and per-file mode. Preserve original cleanup custody on interruption or replacement;
never overwrite or remove an existing destination. Recheck runtime packages before
publishing their supported aliases.

The internal temporary format2 inventory view is only for reusing the existing
full-directory verifier. It is not a transport packet, admission adapter or receipt.
Canonical production inspectors, provenance and installation grants stay format2-only.
No release-controller activation, service restart or deployment follows from this ADR.

## Alternatives and trade-offs

- Keep only gzip ordering: simpler and backward compatible, but large repeated maps
  remain outside its useful history. Retain that verified optimization for format2.
- Remove or rewrite maps: smaller, but changes debugging and is rejected here.
- TAR hardlinks or symlinks: complicate existing safety and shared-inode semantics;
  use checked independent-file copies instead.
- Deduplicate all file types: potentially larger savings, but broadens the first
  reconstruction contract. Limit this qualification to source maps.

The new format adds a bounded map prehash pass and copy/readback work. It reduces
transport bytes, not installed size. Keep its implementation separate so future
controller adoption requires explicit protocol review rather than a permissive reader.

## Qualification and follow-up

Require original-manifest byte/path/mode equality on an authenticated frozen build,
actual source-map lookup parity, independent-copy mutation checks, strict format
refusals and corruption/expansion/link/ownership/interruption negatives. Exercise
atomic activation and rollback only in disposable Linux fixtures. Record exact
producer, receiver, input and toolchain identities with measured size and time.

A later controller-adoption decision must bind the new manifest/provenance and
capability throughout authenticated transport, installation, recovery and release
verification. Until then the diagnostic remains outside canonical release admission.

# Native reference shared output layout

Source-only clarification of approved6018b27d66d8635b88539d6c30f1beaaceefac86.
Root approved the native shared mirror before dependent fixture implementation.
With the whole original source rootDir, separate project outDirs would break
unchanged sibling relative imports in native emitted declarations. ONE private
RUNNER_TEMP outDir preserves native relative declaration/JSON structure; each
project has its own retained config and build-info file. No alias/resolver/host/
rewriter/copier is introduced. Native processes remain fresh and serial.

Precompute one owner per implementation and actual native JS/declaration output;
refuse duplicate/conflicting writes. Native repeated JSON requires identical
source/hash/path/actual bytes and declared shared context. Actual small native
positive and missing/collision controls precede full-graph use. This change
neither qualifies the small fixtures nor substitutes them for the original five
actual application API refusal gates. No normal compiler/gate/release change.
Original720s/12GiB/400-root/600-owned-source caps and source/ambient/strictness
semantics remain. Root and independent review precede hosted qualification.
No local compiler/test/app/child process/build was executed. Production is held.

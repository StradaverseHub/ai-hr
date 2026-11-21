# Native compiler input refusal: bounded stat diagnostic

Original native miniature run 42452420087 at
afdf383fa71dacdd19f7130c17b178aeed32cd83 failed during inventory. Its authenticated
artifact 13605259834 has SHA256
01d7fbfae3995192c307a6eaca7ef32ec7f43a9720f835f1a3861bad16cab8a7.
The native inventory log points to regularHash's combined regular-file,
non-symlink, single-link and byte-bound assertion. The actual failing property
was not captured. The other twelve planned compiler phases remained blocked;
none has passed. Retain the original failure and prior controls separately.

This diagnostic adds only the observed file kind, symlink flag, native link
count, native byte count and existing maximum to that assertion's error text.
It reports no path, content, environment or source-derived error. Every existing
condition, read/hash operation, identity comparison and return value is unchanged.
No input or output custody rule is relaxed. Hard-linked package-manager input
is a hypothesis to verify, not a diagnosed cause or justification for bypass.

The source request updates only this diagnostic, this note and the current
manifest. It does not change compiler options, roots, output ownership, roles,
process ownership, original thirteen phases or 720/848-second limits. No local
behavior/compiler execution occurred. After independent source review, rerun
only the failed native miniature on a standard hosted runner to capture actual
facts. Full application compiler and release acceptance remain open; staging
and production remain held.

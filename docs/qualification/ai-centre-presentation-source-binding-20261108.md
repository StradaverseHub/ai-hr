# Bind the AI Centre prototype's actual source inventory

Exact parent81d61f489dbd8d7a7f0f886aa2651460c46433e2. Root source review found its
two generated inventories stale; both actual static --check commands refused.
These generators hash source only and make no application/database/provider call.
The Linux build's source-admission checks must not be bypassed for a prototype.

Regenerate the provider inventory first, agent inventory last. The provider closure
remains1480 files with digest
e9e422d54fd2762d18b5289b8824a740410c44c8271627a7d28c7cf24c87cfd5;
the agent closure remains472 files with digest
f52df6b40e230c0f1468141758c2b20cfc0716ff5fbcf2718dfb0ad91c083027.
Both subsequent static --check commands pass. The qualification manifest additionally
pins the two generated files. Reviewed core, native SQL, baseline and test bytes
remain exactly those of81d; all actual hosted behavior/build checks are still due.

Literal disclosure approval rows and provenance are unchanged. Fresh generated
hashes do not carry approvals forward or authorize provider egress. Final exact
source binding remains a separate release requirement. No provider/network call,
real HR-data operation, numbered migration, GET adoption or installation occurred.
Staging stays gated on the whole architecture and production remains held.

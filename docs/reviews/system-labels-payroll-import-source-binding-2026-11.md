# System Labels and Payroll import staging source approval

On 6 November 2026 the repository owner approved rebinding the 28 existing AI provider contracts
to source digest `9be030bc9657042e9260d329cf65c8bab80d9e22f9fdead2036ab5c632753206` for staging
verification of the System Labels and Payroll import release. The reviewed source is
`c990ad14d2f77c8574446968d1b3876bbe09acb4` on staging baseline
`eb9411f24f74dc3ce02d1e3fa6a834c7e0ac2d6c`.

Compared with that baseline the provider closure changes label conflict reporting, the Payroll import
attempt and queue modules, the Payroll service export and the six locale catalogs. Provider payload
contracts and transport remain unchanged. The review retains the original 28 records' metadata and
both pending dispositions. This source approval is limited to staging verification.

On 7 November 2026 the owner approved staging verification of the same 28 contracts
at digest `5a36925dcd34b937c8afc1dadd9b0c06d54b1e4ba9a020824f17da67684a038c`.
Reviewed source `0ca3f36b29e755e40b8bced0e586cc692cd718d6` changes three files in the
provider closure after the preceding approval. They classify the existing Payroll import
and confirmation actions, classify the queue and worker files as import support, and
register the batch screen under the existing Payroll access rules. The approval keeps the
same provider payloads, transport, historical metadata and two pending dispositions.

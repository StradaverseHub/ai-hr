# Personnel parameterized page source binding correction

Source-only child of frozen `cf861f77bcab5ef2fbedff675cfc79f3e50668de`.
Independent full review found one stale source hash: the Personnel family owner
had its new page hash, while the separate parameterized-page row still carried
the parent page hash. The existing assertion over all 120 page owners would
correctly fail. The frozen parent remains preserved, unpublished and unexecuted.

This child changes exactly that row's hash to the actual current Personnel page
bytes. All descriptor, product, component, query, permission, protocol, scenario,
DOM and test source remains whole. The existing 120-page assertion is unchanged.
No new behavior or expectation is introduced to hide the stale binding.

The successor source index updates the current census hash and retains every
other parent source pin and all twelve preserved invariants. Independent
source-as-data checking covers every one of the actual 120 parameterized page
paths and hashes, all 170 current family owner rows, all absent/present historical
owner dispositions, and exact one-field equality against the frozen parent.
The parent's source record remains its historical snapshot; no old evidence is
reassigned to this child. Runtime, browser, capacity and release claims remain
false. Root and independent full review precede any upload or hosted controls.

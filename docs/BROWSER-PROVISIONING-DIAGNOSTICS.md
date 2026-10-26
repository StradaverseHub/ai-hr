# Browser tooling transport measurement

The complete staging CI run [40323273298](https://github.com/StradaverseHub/ai-hr/actions/runs/40323273298)
passed 28,096 test cases but took 903 seconds before deployment. Chromium's original
`playwright install --with-deps` step took 720 seconds. In the earlier complete run
40318458523, APT fetched 25.9 MB from the runner's Azure Ubuntu archive in 273 seconds;
browser binary downloads took approximately nine seconds. These observations justify measuring
package transport before changing tests, browser engines or runner sizes.

On the isolated diagnostic branch, the existing registered workflow file
`alpha-staging-browser-checks.yml` runs as `browser-provisioning-diagnostics`. This avoids
changing main or alpha merely to register another workflow. It is manual-only and uses six independent free standard
`ubuntu-24.04` jobs: Chromium, Firefox and WebKit, each with the original runner archive and
the official Ubuntu primary archive over HTTPS. The candidate and lockfile are frozen.
Each variant executes the same complete `pnpm exec playwright install --with-deps` command.
It retains actual exit status, elapsed wall time, raw setup logs, installed package inventory,
source/lock hashes, original archive configuration and a native multilingual raster probe.
It has no staging credentials, database service, application test selection or gate receipt.
Its results cannot authorize release.

The transport helper accepts only the expected Ubuntu 24.04 deb822 archive configuration.
It changes only Azure archive URI values to `https://archive.ubuntu.com/ubuntu`, preserving
the existing suites, components and explicit Ubuntu archive keyring. Unknown layouts and
signature/freshness overrides refuse the experiment. No packages, fonts, engine, assertion,
dependency version or verification requirement are removed. The original signature chain
continues to authenticate APT indexes and package checksums.

References: [Ubuntu package archives](https://ubuntu.com/project/docs/how-ubuntu-is-made/concepts/package-archive/),
[APT source configuration](https://manpages.ubuntu.com/manpages/resolute/man5/sources.list.5.html),
[Playwright CI installation](https://playwright.dev/docs/ci).

Initial diagnostic [40329802693](https://github.com/StradaverseHub/ai-hr/actions/runs/40329802693)
resolved the candidate but all six tooling jobs refused before installation: the managed
suite capacity profile correctly rejected this separately named diagnostic. The original failure
is retained. The repair uses the existing browser diagnostic's supported `legacy` preparation;
the capacity guard is unchanged. Only the six unexecuted comparisons need execution.

The mirror comparison has not yet produced measurements. A faster diagnostic is not proof of a faster complete
release: normal-workflow adoption requires measured results, source review, coverage and
verification-policy binding, then a complete frozen submission-to-staging measurement including
queue, setup, authentication, installation, migrations, restart, source/build arrival and cleanup.
Keep the currently active release candidate and controller unchanged during this experiment.

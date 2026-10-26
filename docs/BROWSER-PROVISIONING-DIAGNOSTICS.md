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
It changes only Azure archive URI values (including GitHub's exact three-entry
`mirror+file:/etc/apt/apt-mirrors.txt` configuration) to `https://archive.ubuntu.com/ubuntu/`, preserving
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

The second attempt 40330361736 completed dependency setup but refused before browser installation:
the expected direct Azure URI is represented by GitHub's mirror-list indirection. The official
[runner image source](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh)
defines that exact file and three ordered official endpoints. The repair recognizes only that
bounded layout, preserves a separate security-pocket stanza and captures original sources before
validation. Both actual failed attempts remain failures, with no browser performance claim.

The mirror comparison has not yet produced measurements. A faster diagnostic is not proof of a faster complete
release: normal-workflow adoption requires measured results, source review, coverage and
verification-policy binding, then a complete frozen submission-to-staging measurement including
queue, setup, authentication, installation, migrations, restart, source/build arrival and cleanup.
Keep the currently active release candidate and controller unchanged during this experiment.

## Early operator packet capability

The actual 2127 release authenticated all archives and changed source/pending state before the
Mac's system rsync refused `--chmod=D700,F600`. A private local reproduction using
`/usr/bin/rsync` returned that same refusal. The prepared operator change exercises the same
shared packet flags on two tiny local files **before** remote access or archive verification,
requiring actual 0700 directories, a regular single-link 0600 packet and identical bytes.
An incompatible binary fails before any staging change. Compatible transports retain every
original source, packet, authority, migration, runtime and cleanup guard.

Six tiny local boundary checks passed, including actual GNU rsync and false-success refusals.
The existing Linux source-transfer fixture cannot run directly on this Mac: it intentionally
uses Linux `/usr/bin/rsync`; an initial direct invocation also lacked its required typed-loader
and source cwd. Those invocation failures remain separate from passing capability cases.
`probe_scope=operator-transport` runs just the new permission cases and existing private Linux
transport boundaries on a free standard runner, with the actual frozen candidate release helper.
It does not rerun browser installation, application tests, compiler/build or deployment.
This operator change is prepared source, not yet normal-workflow or staging-release verified.

## Official preinstalled image alternative

The first five authenticated mirror measurements on image `20261023.334.3` showed Firefox
runner/primary 25.858/35.059 seconds and WebKit 37.304/68.126 seconds, with byte-identical
paired package inventories and equal browser versions. Chromium primary took46.777 seconds;
its runner comparison was still installing after twelve minutes. A universal primary-mirror
speedup is therefore unproven. Normal release transport remains unchanged.

`probe_scope=browser-image` measures the official Playwright 1.62.1 Noble image, matching the
frozen lockfile and pinned to OCI index digest
`sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`.
The public Microsoft registry returned that digest over HTTPS on26October2026. Three independent
free standard Ubuntu jobs retain actual container initialization/pull timing in their GitHub
job records, install the same frozen web/mobile dependencies with Node22.23.3/pnpm10.33.2,
and run the same native browser/raster probes. The image contains all three engines and system
dependencies, so the diagnostic performs no APT installation. This tests a different provisioning
method; it does not claim application/browser-suite equivalence or release authority. A successful
tooling result still requires complete original browser coverage and resource/cleanup evidence
before normal adoption. See [official image guidance](https://playwright.dev/docs/docker).

Initial image run40334233921 queued from13:51:08 until resolve started14:00:58, a590second
admission wait. The container initialization steps then took26–28seconds; unchanged web/mobile
dependency installation took22–23seconds. Chromium and WebKit native/raster probes passed.
Firefox refused because GitHub supplies `HOME=/github/home`, owned by `pwuser`, while the job
executes as root. The failure explicitly identifies the supported `HOME=/root` workaround.
Only the native launch step receives that corrected home; no browser sandbox flag, assertion or
user-namespace guard is disabled. `probe_scope=browser-image-firefox` reruns only that failed
engine. The original failure and two passing engine records remain intact. Queue time is retained
in the end-to-end evidence, and no sub-ten-minute claim follows from fast container initialization.

# Production packages from approved staging

The final staging acceptance command automatically creates an annotated production tag, source and Linux x64 runtime packages, checksums, a release manifest and GitHub release notes. Source tags live in `StradaverseHub/ai-hr`; packages and release notes live in the separate **private** `StradaverseHub/ai-hr-releases` repository, per the owner's 26 October decision. It captures the existing staging build; it does not rebuild on a Mac or deploy to production.

Run this from a trusted controller checkout on the operator's Mac after the release owner has completed the existing gate, staging restart, migration/arrival checks and acceptance walkthrough. The explicit `--accept-staging` flag is the final human approval action; `--ref` and `--build-id` pin precisely what was accepted. A branch push, CI success or completed build alone is not staging approval.

```sh
python3 scripts/releases/approve_staging.py \
  --accept-staging \
  --github-account GITHUB_ACCOUNT_WITH_ACCESS \
  --ref FULL_APPROVED_COMMIT_SHA \
  --build-id EXACT_ACCEPTED_BUILD_ID \
  --ssh-config /absolute/path/to/private/ssh_config \
  --staging-alias aihr-staging \
  --approval-evidence /absolute/path/to/staging-acceptance-evidence.json
```

Use the original staging acceptance evidence, not a newly fabricated PASS receipt. Add `--owner-exception` when the owner explicitly approved an exception. This label and the evidence file's SHA256 are included in the published private manifest; the original evidence remains private. The publisher does not interpret arbitrary evidence as proof of a full gate or replace the existing release verification rules. Human acceptance of the test workflows remains the release owner's responsibility.

Use `--check` instead of `--accept-staging` for a read-only preflight. Preflight needs no evidence file and reports the running build ID; it never records acceptance or makes GitHub writes. Without either mode, the command refuses to run. A publication must supply the human-accepted build ID and refuses if staging has since rebuilt the same commit. Python 3.9+ with timezone data, Git, OpenSSH and authenticated `gh` are required. No application dependencies, local database or development build are needed. SSH config and verified host keys stay private, and SSH uses strict host-key checking. An organization owner must create the empty private `StradaverseHub/ai-hr-releases` repository and grant the operator write access. The publisher verifies the destination’s numeric repository ID (`1434418441`) and write access, and refuses a public or differently named destination and pins its numeric identity across retries. The GitHub account needs contents write access to both repositories; no production SSH credentials are supplied to GitHub Actions. `--github-account` selects an account already authenticated locally with `gh`; omit it to use the current account. The selected token stays in child-process environments, is never printed or stored in release state, and does not switch the shared GitHub login. Git transport honors local hooks and explicitly disables `push.followTags` so unrelated tags cannot be copied.

## What happens after approval

1. Require the exact accepted SHA to be present in both published `alpha` and `main` histories, and verify the canonical source repository ID. Source visibility may be public; package destination visibility must be private. Heads may advance for release recording or later development, including independently; compare ancestry using their immutable commit IDs. Never substitute a newer head for the accepted commit. Repeat this check before publication; a reset that removes the accepted commit refuses publication. Branch ancestry proves lineage, not human acceptance.
2. Verify the staging deployment is `ok`, source/build refs and build IDs agree, the service is active and was restarted after the build, and loopback health succeeds. Hash the deployed source files covered by the official rsync contract against the exact Git archive. Check installed dependencies against the committed lockfile.
3. Capture `.next` and `node_modules` from that Linux x64 staging build, excluding caches, development output and trace logs. Check staging again after capture and immediately before publication; refuse a changed build, service or source. Keep the staging acceptance window exclusive until capture finishes.
4. Audit archives without extracting them. Refuse private environment files, installation configuration, escaping links, unsafe paths, cache output and prerendered customer/application pages. A future release with intentionally public prerendered pages needs an explicit reviewed policy change rather than a blanket exception.
5. Allocate `prod-YYYY-MM-DD.N`, using the acceptance date in **Asia/Kuala_Lumpur**. Existing tags, including manually created tags, count toward the daily sequence. Atomic GitHub ref creation arbitrates concurrent operators; tags always point to the approved full SHA.
6. Copy the exact annotated tag and its source history to the private package repository, without force or branch updates. This first transfer may take longer because the private repository starts empty. Verify both repositories have the same tag object and source commit. Generate notes against the public source history, explicitly starting at the previous private release tag when present. Create a private draft release, upload all five assets and compare every uploaded size and GitHub SHA256 digest with the local bytes. Publish only after the complete inventory matches. Release notes include the source/build identity, approval kind, installation instructions and GitHub-generated commit/PR changes since the previous release.

The five assets are:

- `ai-hr-prod-YYYY-MM-DD.N-source.tar.gz`
- `ai-hr-prod-YYYY-MM-DD.N-linux-x64-runtime.tar.gz`
- `release-manifest.json`
- `RELEASE_NOTES.md`
- `SHA256SUMS` covering the other four assets

Extract both archives into the same application release directory. Supply the compatible Node runtime and private production configuration separately. Follow the normal production update procedure to apply migrations and preserve the database. Publishing a production package does not authorize a database reset or establish that production runs it. The manifest explicitly records that no production deployment was performed.

## Interruptions and retries

Local state lives under the controller checkout's ignored `.improve/production-releases/` directory with private permissions. Keep that directory until publication is confirmed. It contains the prepared archive bytes and tag/release checkpoint; it contains no SSH keys or copied installation environment files. `--output-root` can select another private durable directory.

Rerun the same command with the same accepted SHA/build ID, evidence file, approval kind and output directory. It verifies prepared bytes, resumes missing uploads and checks an already published release without changing it. A mismatching asset refuses publication and is never overwritten. Missing GitHub digest metadata also fails closed. A partial upload may need the operator to remove the incomplete asset from the **draft** before retrying; the publisher does not silently delete anything.

A second operator/output directory checks both repositories for an existing release or reserved tag (including an earlier date) for that source/build and refuses to create a duplicate. Recover the original checkpoint to resume. A lost response to tag creation is recovered using the locally saved tag object. If the local output is lost after reservation, inspect the remote draft/tag and recover deliberately; do not reuse or move a published tag. A genuinely corrected package requires a new accepted build and release.

This is an operator-side event-driven pipeline: accepting staging runs publication immediately. The CI workflow tests the publisher, and never connects to staging or production. Existing older release helpers stop at build completion; they must not invoke approval before the remaining restart/arrival/acceptance work is complete.

## Verification

```sh
python3 -m unittest discover -s scripts/releases -p 'test_*.py' -v
```

The standalone regression tests cover date rollover, daily sequencing, tag collisions, checkpoint ordering, interrupted uploads, published release immutability, duplicate approvals, owner-exception labeling, accepted-commit ancestry after branch movement, refusal of an unmerged candidate, explicit human acceptance and build pinning, private destination identity/visibility refusal, actual Git tag transfer, absence of public release uploads, and archive/configuration/privacy refusal. They use transport doubles and never publish a real release. Run the read-only preflight against the actual approved staging build before using the publisher.

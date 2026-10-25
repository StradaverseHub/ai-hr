# Codex Cloud capability pilot

The owner authorized a Codex Cloud trial on 26 October 2026 MYT. This trial is separate from AI dev 2's frozen local H release and the GitHub Actions performance experiments. Main/live deployment stays disabled; the sole repository is `StradaverseHub/ai-hr`. No billing setting was changed or credits purchased by this pilot. Actual subscription allowance, charges and credit usage were not exposed to the task and remain unknown.

## Actual result

Cloud task `01a17474-88fe-7568-a7d4-cf2ea157a0b5`, host `durable`, turn `01a17474-9715-77f9-9a9c-a4a82153d8bf` completed capability probes in a real isolated Linux workspace. The root independently read its command output, including cgroup limits and the actual Git authentication failure. It did not receive a repository checkout or authenticated GitHub connection. The requested branch was `codex/test-suite-efficiency-review-20261025`, frozen candidate `31aeff6c76286d187b9cf5a10de63c82ebac4d94`; that candidate was not checked out or verified.

| Observation | Actual result |
|---|---|
| OS / architecture | Ubuntu 24.04.3 LTS / Linux x86_64 |
| CPU | 9 visible logical CPUs; cgroup `cpu.max` = `800000 100000`, equivalent to an 8-CPU quota |
| Memory | cgroup `memory.max` = 8,589,934,592 bytes (8 GiB); no swap |
| Disk | 32G overlay, approximately 30G available |
| Default tools | Node 24.22.1, pnpm 11.25.0, npm 11.9.0, Python 3.12.14, Git 2.51.1 |
| Requested toolchain | Node 22 / pnpm 10.33.2 unavailable on PATH; compatibility unverified |
| PostgreSQL | No `psql`, `postgres`, `initdb` or `pg_ctl`; `/usr/lib/postgresql` absent |
| Private repository | `git ls-remote` exited 128: could not read Username for HTTPS GitHub; terminal prompts disabled |
| Package network | npm registry probe timed out establishing proxy CONNECT (exit 28); Ubuntu archive HEAD returned HTTP 200 (exit 0) |
| GitHub/billing telemetry | No GitHub CLI or task usage/credit/billing telemetry exposed |

The Git probe took 3.857 seconds, npm connectivity probe 5.012 seconds and Ubuntu archive probe 3.768 seconds. Inventory took 0.859 seconds. The platform reports a 61.607-second task turn; provisioning had already happened and its duration was unavailable. These timings do not prove clean-candidate submission-to-test speed. Installation, PostgreSQL RLS/rollback smoke, application tests, TypeScript, build and deployment did not run. No owned services or temporary database data were created.

The actual resource shape differs from generic plan defaults in documentation; use the observed limits when sizing this task. Eight CPUs do not imply sufficient memory for eight application workers. The separate standard-runner compiler already reached about 6.6 GiB maximum RSS; that is a different run and not Cloud compiler evidence. Native PostgreSQL, compiler concurrency, package installation and complete release timing still need validation.

## Integration recheck

The owner later reported “Integrated”. A read-only retry in the existing Cloud task, turn `01a17481-70b5-729a-8c7c-f210ef1666be`, still returned Git exit128 with the same authentication error (0.189s); no mounted repository, connector or environment selector was exposed there. Root independently read the underlying command output. No install, database, compiler, app test, build or deployment ran. The owner then clarified that only GitHub was connected, not a repository-backed Cloud environment published. This does not establish a broken GitHub connection globally; it establishes that this existing task still lacks repository access.

Automated native inspection of `com.openai.codex` was explicitly blocked by the app's safety controls. It was not bypassed. The remaining setup is the documented environment selection/publication flow below, followed by a task started from that published environment. No further access retry or new Cloud task has been started after this clarification.

## Latest connection report and actual UI observation

The owner subsequently reported “cloud codex connected”. Root followed the official “Go to Cloud” link in a new Chrome tab. The resulting signed-in ChatGPT page showed Zen Lam Pro, Cloud selected, and a Choose environment picker that still said “Connect GitHub to see your environments”. Clicking Create environment produced no new setup page or tab. This is an observation of that browser/account context, not proof that the owner's other Cloud workspace lacks a connection. Root requested the connected environment URL to locate the correct workspace. No additional GitHub permission was granted, no billing setting changed and no new workload started. The old generic scratch pilot was not blindly retried.

## Required setup before retry

Use the supported Cloud environment flow: **Work in → Cloud → Select environment → Create environment**, connect GitHub if prompted, and select only `StradaverseHub/ai-hr`. Configure the required Node 22, pnpm 10.33.2 and PostgreSQL 16 tools plus package-registry access during setup, review its report, then publish. The current chat tools can create a Cloud task but cannot configure that repository connection. Account authorization must go through the product's GitHub connection UI; do not paste a personal access token, Mac environment file, staging credentials or SSH keys into a task prompt.

After a published environment exists, resume with an isolated exact-candidate capability check and tiny owned PostgreSQL smoke before application workloads. Preserve NOBYPASSRLS application roles, RLS isolation, rollback and explicit cleanup. Do not masquerade as GitHub Actions or bypass the GitHub-only controller guards. Do not duplicate the completed paired GitHub benchmark or relabel capability checks as release evidence. No automatic retry is running while access is missing.

Official setup references checked on 26 October: [Codex Cloud](https://learn.chatgpt.com/docs/cloud) and [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments). Their environment workflow is guidance, not proof that our private repository is connected.

## Relation to the release-time goal

Cloud capability is an option for removing Mac contention, not a verified speedup or a completed release path. The first standard GitHub runner attendance pilot passed all 100 attendance cases and whole-repository TypeScript in 9m04s from dispatch to last job completion, consuming 15.6 occupied runner-minutes; it omitted build/deployment and was not a full gate. The separate same-runner split/monolith comparison is [run 40223846855](https://github.com/StradaverseHub/ai-hr/actions/runs/40223846855), pinned to `31aeff6c76286d187b9cf5a10de63c82ebac4d94`; inspect live GitHub state and authenticated artifacts for its outcome. This Cloud trial did not repeat those workloads. The complete under-ten-minute testing and verified staging deployment goal remains unachieved.

The latest direct browser check reached the Create a cloud environment dialog: no repository selected and Get started disabled. Connect GitHub opened a consent dialog; root cancelled it without granting additional access. The connected/published environment URL has been requested from the owner to identify the correct workspace. No generic scratch-task retry or new Cloud workload follows from a connection claim alone. H has since completed verified staging arrival and resource handback; Mobile owns local runtime resources.


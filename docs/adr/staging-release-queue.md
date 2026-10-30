# Shared staging queue and non-expiring lease

Decision: approved by the owner on 30 October 2026; implementation and commissioning evidence are separate.

Parallel Claude and Codex sessions verify on GitHub Actions, but share one staging application,
service and migration ledger. Informal window announcements cannot prevent concurrent source transfer
or a second operator entering while a disconnected detached deployment is still running.

Use one staging-host SQLite queue and a non-expiring lease outside the rsynced tree. Existing private
SSH access authenticates operators. Give the lease a monotonically increasing epoch and a private
credential; retain an audit trail and immutable candidate/batch identities. Kernel operation locks
protect command lifetime and explicit recovery. Expiry-based takeover is rejected because elapsed
wall time cannot establish whether a detached build or migration has stopped.

Start with one to three ordinary, migration-free members per batch and isolate higher-risk changes.
Verify the exact aggregate under existing policy. Queue admission never supplies CI or acceptance
authority. Revalidate the live baseline and retain original failures and evidence. Keep installation,
acceptance and required package capture exclusive; production still requires separate authorization.

This adds a staging-host dependency and deliberate operator recovery for abandoned leases. It avoids
new paid infrastructure and model-specific session APIs. It does not secure staging against an
operator able to bypass all supported tooling with arbitrary shell/root access. Existing clients and
installed entry points must adopt enforcement before claiming coverage across all sessions.

Protocol, commands and rollout criteria: [staging release queue](../STAGING-RELEASE-QUEUE.md).
Revisit batch size and preview environments using measured queue/occupancy and failure data.

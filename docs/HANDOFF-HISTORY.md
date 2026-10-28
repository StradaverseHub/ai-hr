# Historical handoffs

Round-by-round transcripts have been removed from active documentation. They mixed past source, deployment observations and pending work, and must not drive a current session.

For a specific historical investigation, recover the pre-cleanup log:

```sh
git show d8b2bac9705fd8fbc4d3eb500262b19858bf297d:docs/HANDOFF-HISTORY.md
```

Use Git history and the board for task status, authenticated release/installation records for deployment evidence, and [ADRs](adr/README.md) for durable decisions. Read [repository policy](REPOSITORY-AND-ENVIRONMENTS.md) before changing branches or targets. Add new lasting decisions to an ADR; keep release observations in their evidence system rather than growing this file again.

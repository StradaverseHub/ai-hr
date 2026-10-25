# Private operator access

Staging uses the SSH alias `aihr-staging`. Its actual address, username, port, identity path and
public application origin belong in private operator configuration, outside tracked files.
Production uses separate aliases and credentials; staging configuration does not authorize production deployment.

## Configure an operator workstation

Define the alias in your normal `~/.ssh/config`, or put it in this checkout's ignored
`.improve/ssh_config`. Keep the directory mode 0700 and file mode 0600. The following values are
illustrative; fill the actual settings in a private editor:

```sshconfig
Host aihr-staging
    HostName staging-host.example.com
    User DEPLOY_USER
    Port SSH_PORT
    IdentityFile ~/.ssh/STAGING_KEY
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

The operator scripts automatically use `.improve/ssh_config` when present. To share a private config
across worktrees, set `AIHR_SSH_CONFIG` to its absolute path. Otherwise standard OpenSSH configuration
is used. Explicit `IMPROVE_SSH_HOST`, `IMPROVE_SSH_USER` and `IMPROVE_SSH_PORT` override alias settings;
when using a literal host, supply any required username and port privately. `IMPROVE_REMOTE_DIR`
defaults to `/opt/ai-hr`.

For manual SSH/rsync commands, select the same configuration explicitly when using the ignored file:

```bash
ssh -F .improve/ssh_config aihr-staging 'cd /opt/ai-hr && deploy/deploy-state.sh status'
pnpm improve:status
```

Verify the server fingerprint through the installation operator before first connection. Retain
host-key checking. Store passwords, tokens and encryption keys in protected server files or a secret
manager, separately from SSH addressing. `.improve/` is ignored and excluded from release uploads.

The existing local staging connection was preserved in the ignored config during this cleanup.
Other operators must configure their own access; cloned repositories do not contain connection details.

## Origin TLS maintenance

`deploy/internal-auth/repair-current-origin-tls.sh` now asks for the actual DNS name, existing Nginx
site configuration, existing certificate directory and Certbot certificate name. Check these against
the target installation before continuing. Generated renewal hooks stay root-owned on that server;
private DNS tokens stay outside source. Source cleanup does not change an installed certificate or hook.

## Scope of removal

Tracked current files use aliases or documentation-only endpoints. Historical handoff entries retain
their technical findings with infrastructure identifiers replaced by examples. Original identifiers
remain in earlier Git commits, other branches, existing clones and any externally shared material.
Removing those copies requires a separately coordinated history rewrite. This change does not rotate
credentials, alter firewalls, move servers or deploy application code.

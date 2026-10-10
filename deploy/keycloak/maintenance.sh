#!/usr/bin/env bash
# Root-only local backup + expired-session maintenance. Configure encrypted off-host retention separately.
set -euo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || exit 1
install -d -m 0700 /var/backups/aihr-keycloak
BACKUP_FILE="/var/backups/aihr-keycloak/identity-$(date -u +%Y%m%dT%H%M%SZ).dump"
runuser -u postgres -- pg_dump --format=custom aihr_identity > "$BACKUP_FILE.partial"
mv "$BACKUP_FILE.partial" "$BACKUP_FILE"
# Never sweep app data, configuration, credentials or the identity database itself.
find /var/backups/aihr-keycloak -maxdepth 1 -type f -name 'identity-*.dump' -mtime +14 -delete
cd /opt/ai-hr
/opt/node20/bin/node --env-file=/opt/ai-hr/.env.production --import tsx scripts/keycloak-session-prune.ts

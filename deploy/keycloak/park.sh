#!/usr/bin/env bash
# Park (stop and disable) the dormant Keycloak identity service and its identity-email agent on an
# installation that uses embedded HR login (ADR-0117, AUTH_PROVIDER=internal). Reversible: nothing is
# deleted. /etc/aihr-keycloak, /opt/aihr-keycloak, the aihr_identity database, /var/lib/aihr-identity-email
# and the daily identity backup job all stay as they are; `unpark` starts both services again.
#
# Why: on the 2-vCPU / 3.9 GB staging box (24 Nov 2026) Keycloak held ~230 MB RSS plus ~390 MB of swap
# and the email agent ~80 MB, with AUTH_PROVIDER=internal, no KEYCLOAK_* app settings, zero /identity/
# requests in the nginx logs and zero connections ever accepted on /run/aihr-identity-email.sock. In
# internal mode the app sends account, notification and report mail through lib/internal-auth, never
# through that socket (lib/identity/email-ipc.ts, lib/notification-email-ipc.ts).
#
#   deploy/keycloak/park.sh status          read-only checks and memory evidence (no root needed)
#   sudo deploy/keycloak/park.sh park       checks, then stop + disable
#   sudo deploy/keycloak/park.sh unpark     enable + start again (rollback)
#
# An installation change: run `park` only with the owner's explicit approval and inside the staging
# lease (docs/STAGING-RELEASE-QUEUE.md). It never restarts the web service.
set -euo pipefail

APP_ENV_FILE="${AIHR_APP_ENV_FILE:-/opt/ai-hr/.env.production}"
KEYCLOAK_UNIT=aihr-keycloak.service
EMAIL_SERVICE=aihr-identity-email.service
EMAIL_SOCKET=aihr-identity-email.socket
WEB_UNIT=aihr.service

refuse() { echo "✗ $*" >&2; exit 1; }
show() { systemctl show -p "$2" --value "$1"; }

# The app's provider selection, read from the file systemd loads. Exactly one AUTH_PROVIDER assignment,
# equal to internal, and no non-empty KEYCLOAK_* setting; anything else means the app may still use Keycloak.
check_app_provider() {
  [ -r "$APP_ENV_FILE" ] || refuse "cannot read the app environment file $APP_ENV_FILE"
  local lines count value
  lines=$(grep -E '^[[:space:]]*(export[[:space:]]+)?AUTH_PROVIDER=' "$APP_ENV_FILE" || true)
  count=$(printf '%s' "$lines" | grep -c . || true)
  [ "$count" -eq 1 ] || refuse "expected exactly one AUTH_PROVIDER assignment in $APP_ENV_FILE, found $count"
  value=${lines#*=}; value=${value%%#*}; value=$(printf '%s' "$value" | tr -d "\"' \t\r")
  [ "$value" = internal ] || refuse "AUTH_PROVIDER is '$value', not internal; Keycloak may be in use"
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?KEYCLOAK_[A-Z0-9_]*=[[:space:]]*[^[:space:]#]' "$APP_ENV_FILE"; then
    refuse "the app environment still sets KEYCLOAK_* values; remove them in a reviewed change first"
  fi
  echo "✓ app selects embedded HR login (AUTH_PROVIDER=internal) with no KEYCLOAK_* settings"
}

# Only the email agent may depend on Keycloak; it is parked with it.
check_dependants() {
  local name dependants
  for name in RequiredBy BoundBy RequisiteOf; do
    for dependants in $(show "$KEYCLOAK_UNIT" "$name"); do
      [ "$dependants" = "$EMAIL_SERVICE" ] || refuse "$dependants depends on $KEYCLOAK_UNIT ($name)"
    done
  done
  echo "✓ no unit other than $EMAIL_SERVICE requires $KEYCLOAK_UNIT"
}

check_email_socket_idle() {
  local open accepted
  open=$(show "$EMAIL_SOCKET" NConnections); accepted=$(show "$EMAIL_SOCKET" NAccepted)
  [ "${open:-0}" = 0 ] || refuse "$EMAIL_SOCKET has $open open connection(s)"
  echo "✓ $EMAIL_SOCKET has no open connections (accepted since it started: ${accepted:-unknown})"
}

evidence() {
  local unit
  for unit in "$KEYCLOAK_UNIT" "$EMAIL_SERVICE" "$EMAIL_SOCKET"; do
    printf '  %-28s %-9s enabled=%-8s memory=%s swap=%s\n' "$unit" "$(show "$unit" ActiveState)" \
      "$(systemctl is-enabled "$unit" 2>/dev/null || true)" "$(show "$unit" MemoryCurrent)" "$(show "$unit" MemorySwapCurrent)"
  done
}

checks() { check_app_provider; check_dependants; check_email_socket_idle; evidence; }

expect_state() {
  local unit=$1 want=$2 got
  got=$(show "$unit" ActiveState)
  [ "$got" = "$want" ] || refuse "$unit is $got, expected $want"
}

case "${1:-status}" in
  status)
    checks
    ;;
  park)
    checks
    [ "$(show "$WEB_UNIT" ActiveState)" = active ] || refuse "$WEB_UNIT is not active; investigate before changing identity services"
    # The dependant first, so its Requires= never restarts Keycloak behind us.
    systemctl disable --now "$EMAIL_SOCKET"
    systemctl stop "$EMAIL_SERVICE"
    systemctl disable --now "$KEYCLOAK_UNIT"
    expect_state "$EMAIL_SOCKET" inactive; expect_state "$EMAIL_SERVICE" inactive; expect_state "$KEYCLOAK_UNIT" inactive
    expect_state "$WEB_UNIT" active
    evidence
    echo "✓ parked. Preserved: /etc/aihr-keycloak, /opt/aihr-keycloak, database aihr_identity, /var/lib/aihr-identity-email, daily backup job."
    echo "  Roll back with: sudo deploy/keycloak/park.sh unpark"
    ;;
  unpark)
    systemctl enable --now "$KEYCLOAK_UNIT"
    systemctl enable --now "$EMAIL_SOCKET"
    expect_state "$KEYCLOAK_UNIT" active; expect_state "$EMAIL_SOCKET" active
    evidence
    echo "✓ unparked. Check readiness: curl -fsS http://127.0.0.1:9000/identity/health/ready"
    ;;
  *)
    refuse "usage: $0 status|park|unpark"
    ;;
esac

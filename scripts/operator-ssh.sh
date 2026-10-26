#!/usr/bin/env bash
# Source from the repository root. Keep actual destinations in private OpenSSH configuration.
AIHR_OPERATOR_HOST="${IMPROVE_SSH_HOST:-aihr-staging}"
AIHR_OPERATOR_USER="${IMPROVE_SSH_USER:-}"
AIHR_OPERATOR_PORT="${IMPROVE_SSH_PORT:-}"
[[ "$AIHR_OPERATOR_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || { echo 'Invalid IMPROVE_SSH_HOST' >&2; return 2; }
[[ -z "$AIHR_OPERATOR_USER" || "$AIHR_OPERATOR_USER" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || { echo 'Invalid IMPROVE_SSH_USER' >&2; return 2; }
if [[ -n "$AIHR_OPERATOR_PORT" ]]; then
  [[ "$AIHR_OPERATOR_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$AIHR_OPERATOR_PORT >= 1 && 10#$AIHR_OPERATOR_PORT <= 65535 )) || { echo 'Invalid IMPROVE_SSH_PORT' >&2; return 2; }
fi
AIHR_OPERATOR_CONFIG="${AIHR_SSH_CONFIG:-}"
if [[ -z "$AIHR_OPERATOR_CONFIG" && -f .improve/ssh_config ]]; then AIHR_OPERATOR_CONFIG="$PWD/.improve/ssh_config"; fi
AIHR_OPERATOR_SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=12)
if [[ -n "$AIHR_OPERATOR_CONFIG" ]]; then
  [[ -f "$AIHR_OPERATOR_CONFIG" ]] || { echo 'AIHR_SSH_CONFIG does not exist' >&2; return 2; }
  AIHR_OPERATOR_SSH_OPTS+=(-F "$AIHR_OPERATOR_CONFIG")
fi
[[ -z "$AIHR_OPERATOR_PORT" ]] || AIHR_OPERATOR_SSH_OPTS+=(-p "$AIHR_OPERATOR_PORT")
AIHR_OPERATOR_TARGET="$AIHR_OPERATOR_HOST"
[[ -z "$AIHR_OPERATOR_USER" ]] || AIHR_OPERATOR_TARGET="$AIHR_OPERATOR_USER@$AIHR_OPERATOR_HOST"

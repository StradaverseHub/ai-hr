#!/usr/bin/env bash
# Run as the PostgreSQL administrator (normally: sudo -u postgres deploy/bootstrap-db.sh).
# Passwords enter through hidden prompts or three newline-terminated stdin records, never argv.
# The only credential-bearing child is psql; its environment dies with this one-time bootstrap.
set +x
set -euo pipefail

die() { printf 'Database bootstrap refused: %s\n' "$1" >&2; exit 2; }
MODE=prompt
case "${1:-}" in
  '') ;;
  --stdin) MODE=stdin ;;
  --help)
    printf 'Usage: bootstrap-db.sh [--stdin]\nRead owner, application, and platform passwords in that order.\n'
    exit 0 ;;
  *) die 'use no arguments for hidden prompts, or --stdin for exactly three password lines.' ;;
esac
[ "$#" -le 1 ] || die 'unexpected arguments; passwords must never be command arguments.'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PSQL_BIN="${AIHR_PSQL_BIN:-psql}"
PSQL_VERSION=$("$PSQL_BIN" --version) || die 'psql is unavailable; install the PostgreSQL 16 client.'
if [[ ! "$PSQL_VERSION" =~ PostgreSQL\)\ ([0-9]+) ]] || [ "${BASH_REMATCH[1]}" -lt 16 ]; then
  die 'psql 16 or newer is required for secure environment-variable input.'
fi

# Refuse inherited credentials: this entry point accepts only the explicitly supplied input.
unset AIHR_BOOTSTRAP_OWNER_PW AIHR_BOOTSTRAP_APP_PW AIHR_BOOTSTRAP_PLATFORM_PW
trap 'unset AIHR_BOOTSTRAP_OWNER_PW AIHR_BOOTSTRAP_APP_PW AIHR_BOOTSTRAP_PLATFORM_PW' EXIT

read_password() {
  local variable="$1" label="$2"
  if [ "$MODE" = prompt ]; then
    [ -t 0 ] || die 'no interactive terminal; use --stdin with three newline-terminated password lines.'
    IFS= read -r -s -p "$label password: " "$variable" || die 'password input ended early.'
    printf '\n' >&2
  else
    IFS= read -r "$variable" || die 'three newline-terminated password lines are required.'
  fi
  [ -n "${!variable}" ] || die "$label password is missing or empty; no roles were created."
}

read_password AIHR_BOOTSTRAP_OWNER_PW Owner
read_password AIHR_BOOTSTRAP_APP_PW Application
read_password AIHR_BOOTSTRAP_PLATFORM_PW Platform
if [ "$MODE" = stdin ]; then
  extra=''
  if IFS= read -r extra || [ -n "$extra" ]; then
    die 'expected exactly three password lines; no roles were created.'
  fi
fi
export AIHR_BOOTSTRAP_OWNER_PW AIHR_BOOTSTRAP_APP_PW AIHR_BOOTSTRAP_PLATFORM_PW

# -X excludes user/system psql startup files that could enable query echoing or change safety flags.
# The SQL also enforces ON_ERROR_STOP and validates all passwords before any role/database creation.
"$PSQL_BIN" -X --no-password --dbname=postgres --file="$ROOT/bootstrap-db.sql"

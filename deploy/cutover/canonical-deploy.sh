#!/usr/bin/env bash
# Reconcile canonical deployment while the verified green runtime serves ingress.
set -Eeuo pipefail
umask 077
root=/var/lib/aihr-cutover
live=/opt/ai-hr
state=/var/tmp/aihr-deploy
[[ "$#" == 4 && "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{40}$ && "$3" =~ ^[A-Za-z0-9_-]{1,128}$ && "$4" =~ ^[A-Za-z0-9_-]{1,128}$ ]]
artifact=$1
baseline=$2
old=$3
new=$4
stage=$root/prepared/$artifact
source=$root/source/$artifact
cd "$live"
[[ "$AIHR_STAGING_CANDIDATE" =~ ^[a-f0-9]{40}$ ]]
candidate=$AIHR_STAGING_CANDIDATE
queue=$state/staging-release-queue
dstate() { bash deploy/deploy-state.sh "$@"; }
verify_state() {
  local source=$1 build=$2 actual line
  actual=$(dstate status)
  for line in state=ok stale_build=0 "ref=$source" "built_ref=$source" "build_id=$build" "built_build_id=$build"; do
    grep -Fxq "$line" <<<"$actual"
  done
}
current_build=$(cat .next/BUILD_ID)
if [[ "$current_build" == "$new" ]]; then
  verify_state "$candidate" "$new"
  exit
fi

source_rsync() {
  local -a exclude=(node_modules .next .git '.env*' .turbo coverage .claude graphify-out
    .vitest-attachments '/.improve/' '/scratchpad/' '/mobile/android/' '/mobile/ios/'
    '/mobile/dist/' '/mobile/builds/' '/mobile/.expo/' '/mobile/credentials.json'
    '/mobile/*.p8' '/mobile/*.key' '/mobile/*.pem' '/mobile/*.p12' '/mobile/*.jks'
    '/mobile/*.keystore' '/mobile/*.mobileprovision' '/docs/HANDOFF-HISTORY.md'
    '/docs/adr/' '/.impeccable/hook.cache.json')
  local -a filters=()
  local entry
  for entry in "${exclude[@]}"; do filters+=(--exclude "$entry"); done
  rsync -a --omit-dir-times --delete "${filters[@]}" "$@"
}
exchange() {
  PYTHONDONTWRITEBYTECODE=1 python3 .github/ci/build-activate.py "$1" "$stage/next" "$live" "$2" "$3"
}
prove_direct() {
  local build=$1 deadline=$((SECONDS + 95))
  until PYTHONDONTWRITEBYTECODE=1 python3 "$queue/next_probe.py" \
      --release-directory "$live" --build-id "$build" --port 3000 2>/dev/null; do
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}
python3 -B "$queue/coordinator.py" assert-env
verify_state "$baseline" "$old"
test "$(cat "$stage/next/BUILD_ID")" = "$new"
test "$old" != "$new"
test "$(cat "$source/.next/BUILD_ID")" = "$new"
for lock in pnpm-lock.yaml package.json; do cmp -s "$source/$lock" "$live/$lock"; done
sudo -n -l /usr/bin/systemctl restart aihr >/dev/null
backup=$stage/previous-source
mkdir "$backup"
delta=$stage/source-delta.json
scoped=0
if [[ -f "$delta" ]] && jq -e 'type=="object"' "$delta" >/dev/null; then
  jq -e --arg before "$baseline" --arg after "$candidate" \
    '.baseline==$before and .candidate==$after and (.paths|length)>0 and (.paths|length)<=100
      and ((.paths|unique|length) == (.paths|length))
      and (. as $m | ($m.added // []) as $new
        | ($m.paths - $new) as $old
        | ($new - $m.paths | length)==0
        and (($new|unique|length) == ($new|length))
        and ($m.before|length) == ($old|length) and ($m.after|length) == ($m.paths|length)
        and all(range(0; $old|length);
          (. as $i | ($m.before[$i] | test("^[a-f0-9]{64}  ") and endswith("  " + $old[$i]))))
        and all(range(0; $m.paths|length);
          (. as $i | ($m.after[$i] | test("^[a-f0-9]{64}  ") and endswith("  " + $m.paths[$i])))))' \
    "$delta" >/dev/null
  jq -er '.paths[]' "$delta" > "$stage/source-files"
  jq -r '(.added // [])[]' "$delta" > "$stage/source-added"
  jq -r '(.paths - (.added // []))[]' "$delta" > "$stage/source-existing"
  jq -r '.before[]' "$delta" > "$stage/source-before"
  jq -er '.after[]' "$delta" > "$stage/source-after"
  while IFS= read -r file; do
    case "$file" in
      app/*|components/*|lib/*|messages/*|test/*|db/migrations/*.sql|db/migrations/meta/_journal.json|db/schema.ts|docs/MIGRATION-ALLOCATION.md|deploy/upgrade/index-expansion*.mjs|.github/workflows/staging-upgrade-qualification.yml) ;;
      *) echo "Unexpected source path in scoped promotion" >&2; exit 1 ;;
    esac
    [[ "$file" =~ ^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)+$ ]]
    test "$(realpath -m "$live/$file")" = "$live/$file"
    test "$(realpath -e "$source/$file")" = "$source/$file"
  done < "$stage/source-files"
  while IFS= read -r file; do
    test ! -e "$live/$file" && test ! -L "$live/$file"
  done < "$stage/source-added"
  if [[ -s "$stage/source-existing" ]]; then
    sha256sum --check --strict --status "$stage/source-before"
    rsync -a --files-from="$stage/source-existing" "$live/" "$backup/"
  fi
  (cd "$source" && sha256sum --check --strict --status "$stage/source-after")
  scoped=1
else
  source_rsync --link-dest="$live" "$live/" "$backup/"
fi
# The retained applied SQL is authenticated as a single-link original. Keep
# independent copies in the rollback snapshot even when other files share inodes.
for file in "$stage/previous-source/.github/ci/historical-migrations/"*.sql; do
  [[ -f "$file" ]] || continue
  copy=$(mktemp "$(dirname "$file")/.backup.XXXXXX")
  cp --preserve=mode,timestamps -- "$file" "$copy"
  cmp -s -- "$file" "$copy"
  mv -fT -- "$copy" "$file"
done

rollback() {
  local code=$?
  trap - EXIT
  (( code != 0 )) || return 0
  set +e
  (
    set -e
    dstate begin "$baseline" "$$" "$stage/canonical.log"
    dstate phase cutover-canonical-rollback
    if (( scoped )); then
      while IFS= read -r file; do
        if [[ -e "$live/$file" || -L "$live/$file" ]]; then
          test "$(realpath -e "$live/$file")" = "$live/$file"
          cmp -s -- "$source/$file" "$live/$file"
          rm -- "$live/$file"
        fi
      done < "$stage/source-added"
      if [[ -s "$stage/source-existing" ]]; then
        rsync -a --checksum --files-from="$stage/source-existing" "$backup/" "$live/"
        sha256sum --check --strict --status "$stage/source-before"
      fi
    else
      source_rsync --checksum "$backup/" "$live/"
    fi
    if [[ "$(cat .next/BUILD_ID)" == "$new" ]]; then
      exchange rollback "$old" "$new"
      sudo -n /usr/bin/systemctl restart aihr
    fi
    prove_direct "$old"
    dstate built
    dstate finish 0
    verify_state "$baseline" "$old"
  )
  local rollback_code=$?
  set -e
  if (( rollback_code != 0 )); then
    dstate phase cutover-canonical-recovery-required
    dstate finish 1
  fi
  exit "$code"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
dstate pending "$candidate"
dstate begin "$candidate" "$$" "$stage/canonical.log"
dstate phase cutover-canonical-install
if (( scoped )); then
  rsync -a --checksum --files-from="$stage/source-files" "$source/" "$live/"
else
  source_rsync --checksum "$source/" "$live/"
fi
exchange activate "$new" "$old"
dstate built
sudo -n /usr/bin/systemctl restart aihr
prove_direct "$new"
if (( scoped )); then
  sha256sum --check --strict --status "$stage/source-after"
else
  test -z "$(source_rsync --dry-run --itemize-changes --checksum "$source/" "$live/")"
fi
dstate finish 0
verify_state "$candidate" "$new"
trap - EXIT

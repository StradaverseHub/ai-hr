#!/usr/bin/env bash
# Materialize an authenticated staging packet and warm its runtime before claiming a queue lease.
set -euo pipefail
umask 077
root=/var/lib/aihr-cutover
canonical=/opt/ai-hr
node=/opt/node22/bin/node
[[ "$#" == 1 && "$1" =~ ^/var/tmp/aihr-deploy/cutover-packet-[A-Za-z0-9]+$ ]]
packet=$1
test "$(realpath "$packet")" = "$packet"
test "$(stat -c '%u:%a' "$packet")" = "$(id -u):700"
test "$(stat -c '%u' "$root")" = "$(id -u)"
cd "$packet"
reader() { jq -er "$1" verified.json; }
sha=$(reader .source)
digest=$(reader .archiveSha256)
manifest=$(reader .manifestSha256)
lock=$(reader .lockSha256)
package=$(reader .packageSha256)
source_archive=$(reader .sourceArchiveSha256)
producer=$(reader .buildSourcePath)
build=$(reader .nextBuildId)
[[ "$sha" =~ ^[a-f0-9]{40}$ && "$digest" =~ ^[a-f0-9]{64}$ && "$build" =~ ^[A-Za-z0-9_-]{1,128}$ ]]
[[ "$producer" == /home/runner/work/* ]]
for proof in "$manifest" "$lock" "$package" "$source_archive"; do [[ "$proof" =~ ^[a-f0-9]{64}$ ]]; done
printf '%s  %s\n' "$digest" build.tar.gz "$manifest" build-manifest.json "$source_archive" source.tar.gz | sha256sum -c --status
test "$(sha256sum "$canonical/pnpm-lock.yaml" | cut -d' ' -f1)" = "$lock"
test "$(sha256sum "$canonical/package.json" | cut -d' ' -f1)" = "$package"
test "$("$node" -v)" = "v$(reader .runtime.node)"
deadline=$((SECONDS + 60))
while (( $(awk '/^MemAvailable:/ {print $2}' /proc/meminfo) < 1048576 )); do
  if (( SECONDS >= deadline )); then
    echo 'Staging needs 1 GiB of available memory before warming the second runtime.' >&2
    exit 1
  fi
  sleep 2
done
target=$root/source/$digest
mkdir -m 700 "$target"
tar -xzf source.tar.gz --no-same-owner -C "$target"
test "$(sha256sum "$target/pnpm-lock.yaml" | cut -d' ' -f1)" = "$lock"
test "$(sha256sum "$target/package.json" | cut -d' ' -f1)" = "$package"
cp -a --reflink=auto -- "$canonical/node_modules" "$target/node_modules"
PYTHONDONTWRITEBYTECODE=1 python3 - "$canonical" "$target" <<'PY'
import importlib.util
from pathlib import Path
import sys

installed, target = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("bundle", installed / ".github/ci/build-bundle.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
shim = (target / "node_modules/sharp/node_modules/.bin/semver").resolve(strict=True)
original = (installed / "node_modules/sharp/node_modules/.bin/semver").resolve(strict=True)
if not shim.is_relative_to(target / "node_modules") or shim.samefile(original):
    raise ValueError("Independent runtime dependency wrapper required")
data = shim.read_bytes()
if str(installed / "node_modules").encode() in data:
    shim.write_bytes(module.rebase_installer_shim(data, installed, str(target)))
PY
PYTHONDONTWRITEBYTECODE=1 python3 "$canonical/.github/ci/build-bundle.py" unpack-with-origin \
  "$packet/build.tar.gz" "$packet/build-manifest.json" "$target/.next" "$target" "$producer"
test "$(cat "$target/.next/BUILD_ID")" = "$build"

port=$("$node" -e 'const socket=require("node:net").createServer();socket.listen(0,"127.0.0.1",()=>{console.log(socket.address().port);socket.close()});')
[[ "$port" =~ ^[0-9]{4,5}$ ]]
unit=aihr-cutover-$digest
conf=$HOME/.config/systemd/user
mkdir -p -m 700 "$conf"
test ! -e "$conf/$unit.service" && test ! -e "$conf/$unit.socket" && test ! -e "$conf/$unit-proxy.service"
socket=$root/endpoints/$digest.sock
[[ ! -e "$socket" ]]
rollback() {
  local status=$?
  if (( status )); then
    systemctl --user disable --now "$unit.service" "$unit.socket" || true
    systemctl --user stop "$unit-proxy.service" || true
  fi
  return "$status"
}
trap rollback EXIT
cat >"$conf/$unit.service" <<APP
[Unit]
Description=Prepared AI HR staging runtime
[Service]
WorkingDirectory=$target
EnvironmentFile=$canonical/.env.production
UnsetEnvironment=DEV_TENANT_ID DEV_USER_ID MIGRATION_DATABASE_URL
Environment=PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=512
ExecStart=$node $target/node_modules/next/dist/bin/next start -H 127.0.0.1 -p $port
Restart=on-failure
RestartSec=3
MemoryHigh=640M
MemoryMax=768M
NoNewPrivileges=true
[Install]
WantedBy=default.target
APP
cat >"$conf/$unit.socket" <<SOCK
[Unit]
Description=Prepared AI HR staging release socket
[Socket]
ListenStream=$socket
SocketMode=0660
Service=$unit-proxy.service
RemoveOnStop=true
[Install]
WantedBy=sockets.target
SOCK
cat >"$conf/$unit-proxy.service" <<PROXY
[Unit]
Description=Prepared AI HR staging upstream bridge
[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:$port
NoNewPrivileges=true
PROXY
systemctl --user daemon-reload
systemctl --user enable --now "$unit.service" "$unit.socket"
test "$(stat -c '%G:%a' "$socket")" = www-data:660
deadline=$((SECONDS + 120))
until PYTHONDONTWRITEBYTECODE=1 python3 /var/tmp/aihr-deploy/staging-release-queue/next_probe.py \
    --release-directory "$target" --build-id "$build" --socket "$socket" 2>/dev/null; do
  (( SECONDS < deadline ))
  systemctl --user is-active --quiet "$unit.service"
  sleep 2
done
jq -cn --arg sha "$sha" --arg digest "$digest" --arg build "$build" --arg schema "$(reader .schema)" \
  '{release:{source:$sha,artifact:$digest,schema:$schema},build:$build}' > "$packet/release.json"
install -m 600 "$packet/release.json" "$root/releases/$digest.json"
printf 'Staged and warmed %s under build %s.\n' "$sha" "$build"

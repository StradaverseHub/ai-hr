#!/usr/bin/env bash
# Install the staging-only ingress bridge while leaving the canonical app selected.
set -euo pipefail
umask 077
[[ "$(id -u)" == 0 && "$#" == 2 ]]
site=$1
operator=$2
root=/var/lib/aihr-cutover
queue=/var/tmp/aihr-deploy/staging-release-queue
unit=/etc/systemd/system/aihr-cutover-canonical
upstream=/etc/nginx/conf.d/00-aihr-staging-cutover.conf
[[ "$site" =~ ^/etc/nginx/conf.d/[a-zA-Z0-9_-]*staging[a-zA-Z0-9_-]*\.conf$ ]]
[[ "$operator" =~ ^[a-z][a-z0-9_-]*$ && "$operator" != root ]]
test -f "$site" && test ! -L "$site" && test "$(stat -c %u "$site")" = 0
test -f "$queue/operations.lock" && test ! -L "$queue/operations.lock"
test "$(stat -c %U "$queue/operations.lock")" = "$operator"
test "$(systemctl show aihr -p User --value)" = "$operator"
test "$(systemctl show aihr -p WorkingDirectory --value)" = /opt/ai-hr
test -x /usr/lib/systemd/systemd-socket-proxyd
systemctl is-active --quiet nginx
systemctl is-active --quiet aihr
exec 9<>"$queue/operations.lock"
flock -n -x 9
/usr/sbin/nginx -t
[[ "$(grep -Fc 'proxy_pass http://127.0.0.1:3000;' "$site")" == 1 ]]
origin=$(awk '$1 == "server_name" && NF == 2 { sub(/;$/, "", $2); print $2 }' "$site" | sort -u)
[[ "$origin" =~ ^[a-zA-Z0-9.-]+$ && "$origin" == *staging* ]]
for path in "$root" "$unit.socket" "$unit.service" "$upstream"; do
  [[ ! -e "$path" && ! -L "$path" ]]
done
build=$(cat /opt/ai-hr/.next/BUILD_ID)
[[ "$build" =~ ^[A-Za-z0-9_-]{1,128}$ ]]
manifest="/_next/static/$build/_buildManifest.js"
digest=$(sha256sum "/opt/ai-hr/.next/static/$build/_buildManifest.js" | cut -d' ' -f1)
[[ "$(curl -fsS --max-time 8 "https://$origin$manifest" | sha256sum | cut -d' ' -f1)" == "$digest" ]]

backup=$(mktemp /etc/nginx/aihr-staging-cutover-original.XXXXXX)
cp --preserve=mode,ownership -- "$site" "$backup"
changed_site=0
prepared_root=0
installed_units=0
installed_upstream=0
restore() {
  local reason=$?
  trap - EXIT
  set +e
  if (( changed_site )); then cp --preserve=mode,ownership -- "$backup" "$site"; fi
  if (( installed_upstream )); then rm -- "$upstream"; fi
  if (( changed_site || installed_upstream )); then
    if ! /usr/sbin/nginx -t || ! systemctl reload nginx; then
      echo "Nginx restoration requires operator attention. Original: $backup" >&2
      exit "$reason"
    fi
  fi
  if (( installed_units )); then
    systemctl disable --now aihr-cutover-canonical.socket
    systemctl stop aihr-cutover-canonical.service
    rm -f -- "$unit.socket" "$unit.service"
    systemctl daemon-reload
  fi
  if (( prepared_root )); then
    rm -f -- "$root/active.sock"
    rmdir -- "$root/endpoints" "$root/prepared" "$root/releases" "$root/source" "$root"
  fi
  exit "$reason"
}
trap restore EXIT

install -d -o "$operator" -g www-data -m 2750 "$root" "$root/endpoints"
prepared_root=1
install -d -o "$operator" -g www-data -m 2700 "$root/prepared" "$root/releases" "$root/source"
ln -s "$root/canonical.sock" "$root/active.sock"
installed_units=1
cat >"$unit.socket" <<SOCKET
[Unit]
Description=Canonical AI HR staging backend socket
[Socket]
ListenStream=$root/canonical.sock
SocketUser=$operator
SocketGroup=www-data
SocketMode=0660
RemoveOnStop=true
[Install]
WantedBy=sockets.target
SOCKET
cat >"$unit.service" <<'SERVICE'
[Unit]
Description=Canonical AI HR staging backend bridge
[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:3000
DynamicUser=true
NoNewPrivileges=true
SERVICE
chmod 644 "$unit.socket" "$unit.service"
systemctl daemon-reload
systemctl enable --now aihr-cutover-canonical.socket
[[ "$(curl -fsS --max-time 8 --unix-socket "$root/canonical.sock" "http://localhost$manifest" | sha256sum | cut -d' ' -f1)" == "$digest" ]]

installed_upstream=1
cat >"$upstream" <<NGINX
upstream aihr_staging_cutover {
    server unix:$root/active.sock;
}
server {
    listen 127.0.0.1:3301;
    server_name $origin;
    location / {
        proxy_pass http://aihr_staging_cutover;
        proxy_set_header Host $origin;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINX
chmod 644 "$upstream"
temp=$(mktemp /etc/nginx/aihr-staging-cutover-site.XXXXXX)
sed 's@proxy_pass http://127\.0\.0\.1:3000;@proxy_pass http://aihr_staging_cutover;@' "$site" > "$temp"
chmod --reference="$site" "$temp"
chown --reference="$site" "$temp"
changed_site=1
mv -fT -- "$temp" "$site"
/usr/sbin/nginx -t
systemctl reload nginx
for base in http://127.0.0.1:3301 "https://$origin"; do
  deadline=$((SECONDS + 20))
  until curl -fsS --max-time 4 "$base/health" 2>/dev/null | jq -e '. == {"status":"ok"}' >/dev/null &&
      [[ "$(curl -fsS --max-time 4 "$base$manifest" 2>/dev/null | sha256sum | cut -d' ' -f1)" == "$digest" ]]; do
    if (( SECONDS >= deadline )); then
      printf 'Timed out verifying the canonical build at %s. Restoring original ingress.\n' "$base" >&2
      exit 1
    fi
    sleep 1
  done
done
trap - EXIT
printf 'Canonical staging build %s verified through both ingress routes. Original site: %s\n' "$build" "$backup"

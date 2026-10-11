#!/usr/bin/env bash
# Privileged, reviewable installation. Does not select AUTH_PROVIDER or change the live tunnel.
set -euo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run this script through the approved server administrator.' >&2; exit 1; }
: "${AUTH_PUBLIC_ORIGIN:?Set the public HTTPS origin before installation}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_HOST="$(python3 - "$AUTH_PUBLIC_ORIGIN" <<'PY'
import sys,urllib.parse
u=urllib.parse.urlsplit(sys.argv[1])
assert u.scheme=='https' and u.hostname and not u.username and not u.password and not u.query and not u.fragment and not u.port and u.path in ('','/')
assert sys.argv[1]=='https://'+u.hostname
print(u.hostname)
PY
)"
[ ! -e /etc/aihr-keycloak/service.env ] || { echo 'An identity installation already exists. Use its controlled upgrade procedure.' >&2; exit 1; }
command -v psql >/dev/null
command -v nginx >/dev/null
command -v openssl >/dev/null
if ss -ltnH '( sport = :8080 or sport = :9000 or sport = :3001 )' | grep -q .; then
  echo 'A required identity or edge port is already in use. Inspect before proceeding.' >&2; exit 1
fi
if runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='aihr_identity'" | grep -q 1; then
  echo 'Identity database role already exists; inspect before proceeding.' >&2; exit 1
fi
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update
apt-get install -y --no-install-recommends openjdk-25-jre-headless ca-certificates curl
# Select the installed package explicitly; an operator's existing Java alternatives stay untouched.
IDENTITY_JAVA_BIN="$(dpkg-query -L openjdk-25-jre-headless | awk '/\/bin\/java$/ && !found { print; found=1 }')"
[ -x "$IDENTITY_JAVA_BIN" ] || { echo 'The required Java runtime was not installed.' >&2; exit 1; }
IDENTITY_JAVA_HOME="$(dirname "$(dirname "$IDENTITY_JAVA_BIN")")"
VERSION=26.8.0
SHA256=9e41da899f838a58cd510fc98ed4f7cadc715aed5683e42aca20a0c9a2a3980a
INSTALL_TMP="$(mktemp -d)"
trap 'rm -rf -- "$INSTALL_TMP"' EXIT
if [ -n "${KEYCLOAK_ARCHIVE_FILE:-}" ]; then
  cp -- "$KEYCLOAK_ARCHIVE_FILE" "$INSTALL_TMP/keycloak.tar.gz"
else
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    "https://github.com/keycloak/keycloak/releases/download/$VERSION/keycloak-$VERSION.tar.gz" -o "$INSTALL_TMP/keycloak.tar.gz"
fi
echo "$SHA256  $INSTALL_TMP/keycloak.tar.gz" | sha256sum --check --status
id aihr-keycloak >/dev/null 2>&1 || useradd --system --home-dir /opt/aihr-keycloak --shell /usr/sbin/nologin aihr-keycloak
install -d -m 0755 /opt/aihr-keycloak
[ ! -e "/opt/aihr-keycloak/keycloak-$VERSION" ] || { echo 'Version directory exists; inspect it first.' >&2; exit 1; }
tar --no-same-owner -xzf "$INSTALL_TMP/keycloak.tar.gz" -C /opt/aihr-keycloak
chown -R root:root "/opt/aihr-keycloak/keycloak-$VERSION"
chmod -R go-w "/opt/aihr-keycloak/keycloak-$VERSION"
ln -s "keycloak-$VERSION" /opt/aihr-keycloak/current
id aihr-identity-email >/dev/null 2>&1 || useradd --system --gid aihr-keycloak --home-dir /var/lib/aihr-identity-email --shell /usr/sbin/nologin aihr-identity-email
install -d -o aihr-identity-email -g aihr-keycloak -m 0750 /var/lib/aihr-identity-email /var/lib/aihr-identity-email/vault
install -d -m 0700 /etc/aihr-keycloak
IDENTITY_DB_PASSWORD="$(openssl rand -hex 32)"
BOOTSTRAP_PASSWORD="$(openssl rand -hex 32)"
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE aihr_identity LOGIN PASSWORD '$IDENTITY_DB_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE aihr_identity OWNER aihr_identity ENCODING 'UTF8';
REVOKE ALL ON DATABASE aihr_identity FROM PUBLIC;
SQL
cat > /etc/aihr-keycloak/service.env <<ENV
JAVA_HOME=$IDENTITY_JAVA_HOME
KC_DB=postgres
KC_DB_URL=jdbc:postgresql://127.0.0.1:5432/aihr_identity
KC_DB_USERNAME=aihr_identity
KC_DB_PASSWORD=$IDENTITY_DB_PASSWORD
KC_HOSTNAME=$AUTH_PUBLIC_ORIGIN/identity
KC_HOSTNAME_STRICT=true
KC_HOSTNAME_ADMIN=http://localhost:8081/identity
KC_VAULT=file
KC_VAULT_DIR=/var/lib/aihr-identity-email/vault
KC_SPI_TRUSTSTORE__FILE__HOSTNAME_VERIFICATION_POLICY=STRICT
KC_HTTP_ENABLED=true
KC_HTTP_HOST=127.0.0.1
KC_HTTP_PORT=8080
KC_HTTP_RELATIVE_PATH=/identity
KC_PROXY_HEADERS=xforwarded
KC_PROXY_TRUSTED_ADDRESSES=127.0.0.1/32,::1/128
KC_HEALTH_ENABLED=true
KC_METRICS_ENABLED=true
KC_HTTP_MANAGEMENT_HOST=127.0.0.1
KC_BOOTSTRAP_ADMIN_USERNAME=aihr-bootstrap-operator
KC_BOOTSTRAP_ADMIN_PASSWORD=$BOOTSTRAP_PASSWORD
JAVA_OPTS_KC_HEAP=-Xms128m -Xmx640m
ENV
chmod 0600 /etc/aihr-keycloak/service.env
# EnvironmentFile is read by systemd as root; the service itself cannot read bootstrap/database secrets from disk.
JAVA_HOME="$IDENTITY_JAVA_HOME" /opt/aihr-keycloak/current/bin/kc.sh build --vault=file --db=postgres --http-relative-path=/identity --health-enabled=true --metrics-enabled=true
# Extraction/build under umask 077 leaves public distribution files unreadable to the service.
# Credentials live outside this tree; restore public read/execute before protecting writable data.
chmod -R a+rX,go-w "/opt/aihr-keycloak/keycloak-$VERSION"
install -d -o aihr-keycloak -g aihr-keycloak -m 0700 /opt/aihr-keycloak/current/data
install -m 0644 "$SCRIPT_DIR/aihr-keycloak.service" /etc/systemd/system/aihr-keycloak.service
systemctl daemon-reload
systemctl enable --now aihr-keycloak
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:9000/identity/health/ready >/dev/null; then break; fi
  sleep 2
done
curl --fail --silent http://127.0.0.1:9000/identity/health/ready >/dev/null
sed "s/@PUBLIC_HOST@/$PUBLIC_HOST/g" "$SCRIPT_DIR/edge.conf.template" > /etc/nginx/sites-available/aihr-identity
ln -s /etc/nginx/sites-available/aihr-identity /etc/nginx/sites-enabled/aihr-identity
nginx -t
systemctl reload nginx
echo 'Keycloak is installed privately. Configure the realm, link the initial owner, verify login/recovery, then perform the controlled tunnel and app cutover.'

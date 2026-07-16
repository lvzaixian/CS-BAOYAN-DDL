#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
DEPLOY_USER=${DEPLOY_USER:-}
SERVER_NAME=${SERVER_NAME:-}
DEPLOY_ROOT=${DEPLOY_ROOT:-/srv/cs-baoyan-ddl}
NGINX_TEMPLATE=${NGINX_TEMPLATE:-$SCRIPT_DIR/nginx/cs-baoyan-ddl.conf}
NGINX_CONFIG=${NGINX_CONFIG:-/etc/nginx/conf.d/cs-baoyan-ddl.conf}
NGINX_BIN=${NGINX_BIN:-nginx}
TLS_CERTIFICATE=${TLS_CERTIFICATE:-}
TLS_CERTIFICATE_KEY=${TLS_CERTIFICATE_KEY:-}

fail() {
  printf 'bootstrap failed: %s\n' "$*" >&2
  exit 1
}

test "${EUID:-$(id -u)}" -eq 0 \
  || fail 'run this one-time bootstrap as root; the deploy user must not receive sudo'
test -n "$DEPLOY_USER" || fail 'DEPLOY_USER is required'
test -n "$SERVER_NAME" || fail 'SERVER_NAME is required'

case "$SERVER_NAME" in
  *[!a-z0-9.-]*|.*|*..*|*.) fail 'SERVER_NAME must be one explicit lowercase DNS name or IPv4 address' ;;
esac
case "$DEPLOY_ROOT" in
  /*) ;;
  *) fail 'DEPLOY_ROOT must be absolute' ;;
esac
case "$DEPLOY_ROOT" in
  *[!A-Za-z0-9._/-]*|*/../*|*/..|*/./*|*/.) fail 'DEPLOY_ROOT contains unsafe path syntax' ;;
esac
test "$DEPLOY_ROOT" != / || fail 'DEPLOY_ROOT must not be /'

case "$NGINX_BIN" in
  /*)
    test -x "$NGINX_BIN" || fail "NGINX_BIN is not executable: $NGINX_BIN"
    ;;
  */*)
    fail 'NGINX_BIN must be an executable absolute path or a bare command name'
    ;;
  '')
    fail 'NGINX_BIN is required'
    ;;
  *)
    resolved_nginx_bin=$(command -v "$NGINX_BIN" 2>/dev/null) \
      || fail "required command is missing: $NGINX_BIN"
    case "$resolved_nginx_bin" in
      /*) ;;
      *) fail "NGINX_BIN did not resolve to an absolute executable: $NGINX_BIN" ;;
    esac
    test -x "$resolved_nginx_bin" \
      || fail "NGINX_BIN is not executable: $resolved_nginx_bin"
    NGINX_BIN=$resolved_nginx_bin
    ;;
esac

for command_name in python3 curl systemctl flock sha256sum tar install id mktemp; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is missing: $command_name"
done
id "$DEPLOY_USER" >/dev/null 2>&1 || fail "DEPLOY_USER does not exist: $DEPLOY_USER"
test -f "$NGINX_TEMPLATE" || fail "Nginx template not found: $NGINX_TEMPLATE"

deploy_group=$(id -gn "$DEPLOY_USER")
test "$deploy_group" = "$DEPLOY_USER" \
  || fail 'DEPLOY_USER primary group name must equal DEPLOY_USER'

# DEPLOY_ROOT must be group-writable so the dedicated deploy user can atomically
# replace only the current symlink. Nginx needs read/traverse access only.
install -d -m 0775 -o root -g "$deploy_group" "$DEPLOY_ROOT"
install -d -m 0755 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/releases"
install -d -m 0750 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/shared"
install -d -m 0750 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/shared/staging"
install -d -m 0750 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/transactions"

rendered_config=$(mktemp)
backup_config=$(mktemp)
had_config=0
cleanup() {
  rm -f -- "$rendered_config" "$backup_config"
}
trap cleanup EXIT

python3 - "$NGINX_TEMPLATE" "$rendered_config" "$SERVER_NAME" "$DEPLOY_ROOT" \
  "$TLS_CERTIFICATE" "$TLS_CERTIFICATE_KEY" <<'PY'
import pathlib
import re
import sys

source, destination, server_name, deploy_root, tls_certificate, tls_certificate_key = sys.argv[1:]
template = pathlib.Path(source).read_text(encoding="utf-8")
for placeholder in ("__SERVER_NAME__", "__DEPLOY_ROOT__"):
    if placeholder not in template:
        raise SystemExit(f"missing required template placeholder: {placeholder}")

tls_placeholders = ("__TLS_CERTIFICATE__", "__TLS_CERTIFICATE_KEY__")
tls_required = any(placeholder in template for placeholder in tls_placeholders)
if tls_required:
    for placeholder in tls_placeholders:
        if placeholder not in template:
            raise SystemExit(f"missing required template placeholder: {placeholder}")

    def safe_absolute_path(name: str, value: str) -> str:
        if not value:
            raise SystemExit(f"{name} is required by the selected Nginx template")
        if not value.startswith("/"):
            raise SystemExit(f"{name} must be an absolute path")
        if value == "/" or not re.fullmatch(r"/[A-Za-z0-9._/-]*", value):
            raise SystemExit(f"{name} contains unsafe path syntax")
        if "//" in value or value.endswith("/") or any(
            part in (".", "..") for part in value.split("/")
        ):
            raise SystemExit(f"{name} contains unsafe path syntax")
        return value

    tls_certificate = safe_absolute_path("TLS_CERTIFICATE", tls_certificate)
    tls_certificate_key = safe_absolute_path("TLS_CERTIFICATE_KEY", tls_certificate_key)

replacements = {
    "__SERVER_NAME__": server_name,
    "__DEPLOY_ROOT__": deploy_root,
}
if tls_required:
    replacements.update(
        {
            "__TLS_CERTIFICATE__": tls_certificate,
            "__TLS_CERTIFICATE_KEY__": tls_certificate_key,
        }
    )

rendered = template
for placeholder, value in replacements.items():
    rendered = rendered.replace(placeholder, value)
if any(placeholder in rendered for placeholder in replacements):
    raise SystemExit("unrendered Nginx placeholder remains")
pathlib.Path(destination).write_text(rendered, encoding="utf-8")
PY

if test -f "$NGINX_CONFIG"; then
  cp -p -- "$NGINX_CONFIG" "$backup_config"
  had_config=1
fi
install -m 0644 -o root -g root "$rendered_config" "$NGINX_CONFIG"

restore_config() {
  if test "$had_config" -eq 1; then
    install -m 0644 -o root -g root "$backup_config" "$NGINX_CONFIG"
  else
    rm -f -- "$NGINX_CONFIG"
  fi
}

if ! "$NGINX_BIN" -t; then
  restore_config
  fail 'nginx -t rejected the rendered configuration; previous config restored'
fi
if ! systemctl reload nginx; then
  restore_config
  "$NGINX_BIN" -t >/dev/null 2>&1 || true
  systemctl reload nginx >/dev/null 2>&1 || true
  fail 'nginx reload failed; previous config restored'
fi

printf 'bootstrap complete: root=%s user=%s server_name=%s\n' \
  "$DEPLOY_ROOT" "$DEPLOY_USER" "$SERVER_NAME"
printf 'No firewall, sshd, DNS, or TLS settings were changed.\n'

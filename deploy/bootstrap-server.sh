#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
DEPLOY_USER=${DEPLOY_USER:-}
SERVER_NAME=${SERVER_NAME:-}
DEPLOY_ROOT=${DEPLOY_ROOT:-/srv/cs-baoyan-ddl}
NGINX_TEMPLATE=${NGINX_TEMPLATE:-$SCRIPT_DIR/nginx/cs-baoyan-ddl.conf}
NGINX_CONFIG=${NGINX_CONFIG:-/etc/nginx/conf.d/cs-baoyan-ddl.conf}
NGINX_BIN=${NGINX_BIN:-nginx}
NGINX_MAIN_CONFIG=${NGINX_MAIN_CONFIG:-}
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

if test -n "$NGINX_MAIN_CONFIG"; then
  case "$NGINX_MAIN_CONFIG" in
    /*) ;;
    *) fail 'NGINX_MAIN_CONFIG must be an absolute path when set' ;;
  esac
  case "$NGINX_MAIN_CONFIG" in
    *[!A-Za-z0-9._/-]*|/|*//*|*/../*|*/..|*/./*|*/.|*/)
      fail 'NGINX_MAIN_CONFIG contains unsafe path syntax'
      ;;
  esac
fi

for command_name in python3 curl flock sha256sum tar install id mktemp mv; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is missing: $command_name"
done
id "$DEPLOY_USER" >/dev/null 2>&1 || fail "DEPLOY_USER does not exist: $DEPLOY_USER"
test -f "$NGINX_TEMPLATE" || fail "Nginx template not found: $NGINX_TEMPLATE"

deploy_group=$(id -gn "$DEPLOY_USER")
test "$deploy_group" = "$DEPLOY_USER" \
  || fail 'DEPLOY_USER primary group name must equal DEPLOY_USER'

config_lock_path="${NGINX_CONFIG}.lock"
config_lock_fd=9
test ! -L "$config_lock_path" \
  || fail "bootstrap lock path must not be a symbolic link: $config_lock_path"
if ! exec 9<>"$config_lock_path"; then
  fail "could not open bootstrap lock: $config_lock_path"
fi
test ! -L "$config_lock_path" \
  || fail "bootstrap lock path must not be a symbolic link: $config_lock_path"
flock -n "$config_lock_fd" \
  || fail "could not acquire bootstrap lock: $config_lock_path"
printf 'bootstrap lock acquired: %s\n' "$config_lock_path"

python3 - "$NGINX_CONFIG" <<'PY'
import errno
import os
import stat
import sys


def inspect_extended_attributes(target: str):
    unsupported = {errno.ENOTSUP}
    if hasattr(errno, "EOPNOTSUPP"):
        unsupported.add(errno.EOPNOTSUPP)

    if hasattr(os, "listxattr"):
        try:
            return os.listxattr(target, follow_symlinks=False)
        except TypeError:
            return os.listxattr(target)
        except OSError as error:
            if error.errno in unsupported:
                return []
            raise

    if sys.platform == "darwin":
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        listxattr = libc.listxattr
        listxattr.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_size_t,
            ctypes.c_int,
        ]
        listxattr.restype = ctypes.c_ssize_t
        encoded_target = os.fsencode(target)
        size = listxattr(encoded_target, None, 0, 0)
        if size < 0:
            error_number = ctypes.get_errno()
            if error_number in unsupported:
                return []
            raise OSError(error_number, os.strerror(error_number), target)
        if size == 0:
            return []
        buffer = ctypes.create_string_buffer(size)
        used = listxattr(encoded_target, buffer, size, 0)
        if used < 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number), target)
        return [
            os.fsdecode(name)
            for name in buffer.raw[:used].split(b"\0")
            if name
        ]

    return []

path = sys.argv[1]
try:
    metadata = os.lstat(path)
except FileNotFoundError:
    raise SystemExit(0)

prefix = "bootstrap failed: NGINX_CONFIG"
if stat.S_ISLNK(metadata.st_mode):
    raise SystemExit(f"{prefix} must not be a symbolic link: {path}")
if not stat.S_ISREG(metadata.st_mode):
    raise SystemExit(f"{prefix} must be a regular file: {path}")
if metadata.st_nlink != 1:
    raise SystemExit(f"{prefix} must have exactly one link: {path}")
if stat.S_IMODE(metadata.st_mode) != 0o644:
    raise SystemExit(f"{prefix} must have mode 0644: {path}")
if metadata.st_uid != os.geteuid():
    raise SystemExit(f"{prefix} owner UID must match the effective process: {path}")
if metadata.st_gid != os.getegid():
    raise SystemExit(f"{prefix} group GID must match the effective process: {path}")

try:
    extended_attributes = inspect_extended_attributes(path)
except OSError as error:
    raise SystemExit(
        f"{prefix} extended attributes could not be inspected: {path}"
    ) from error
allowed_extended_attributes = {"security.selinux"}
unknown_extended_attributes = sorted(set(extended_attributes) - allowed_extended_attributes)
if unknown_extended_attributes:
    raise SystemExit(
        f"{prefix} has unsupported extended attributes: "
        + ", ".join(unknown_extended_attributes)
    )
PY

# DEPLOY_ROOT must be group-writable so the dedicated deploy user can atomically
# replace only the current symlink. Nginx needs read/traverse access only.
install -d -m 0775 -o root -g "$deploy_group" "$DEPLOY_ROOT"
install -d -m 0755 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/releases"
install -d -m 0750 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/shared"
install -d -m 0750 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/shared/staging"
install -d -m 0750 -o "$DEPLOY_USER" -g "$deploy_group" "$DEPLOY_ROOT/transactions"

rendered_config=$(mktemp)
backup_config=$(mktemp)
config_temp=
had_config=0
cleanup() {
  if test -n "$config_temp"; then
    rm -f -- "$config_temp"
  fi
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

if test -e "$NGINX_CONFIG"; then
  cp -p -- "$NGINX_CONFIG" "$backup_config"
  had_config=1
fi

replace_config() {
  source_config=$1
  config_temp=$(mktemp "${NGINX_CONFIG}.tmp.XXXXXX") \
    || return 1
  if ! install -m 0644 -o root -g root "$source_config" "$config_temp"; then
    rm -f -- "$config_temp"
    config_temp=
    return 1
  fi
  if ! mv -f -- "$config_temp" "$NGINX_CONFIG"; then
    rm -f -- "$config_temp"
    config_temp=
    return 1
  fi
  config_temp=
}

replace_config "$rendered_config" \
  || fail 'could not atomically install the rendered Nginx configuration'

restore_config() {
  if test "$had_config" -eq 1; then
    replace_config "$backup_config"
  else
    rm -f -- "$NGINX_CONFIG"
  fi
}

nginx_test_config() {
  if test -n "$NGINX_MAIN_CONFIG"; then
    "$NGINX_BIN" -t -c "$NGINX_MAIN_CONFIG"
  else
    "$NGINX_BIN" -t
  fi
}

nginx_reload_config() {
  if test -n "$NGINX_MAIN_CONFIG"; then
    "$NGINX_BIN" -s reload -c "$NGINX_MAIN_CONFIG"
  else
    "$NGINX_BIN" -s reload
  fi
}

if ! nginx_test_config; then
  if ! restore_config; then
    if test "$had_config" -eq 1; then
      fail 'nginx -t rejected the rendered configuration; failed to restore previous config'
    fi
    fail 'nginx -t rejected the rendered configuration; failed to remove rendered config'
  fi
  if ! nginx_test_config; then
    if test "$had_config" -eq 1; then
      fail 'nginx -t rejected the rendered configuration; previous config restored but failed revalidation'
    fi
    fail 'nginx -t rejected the rendered configuration; rendered config removed but remaining configuration failed revalidation; no previous config existed'
  fi
  if test "$had_config" -eq 1; then
    fail 'nginx -t rejected the rendered configuration; previous config restored and revalidated'
  fi
  fail 'nginx -t rejected the rendered configuration; rendered config removed and remaining configuration revalidated; no previous config existed'
fi
if ! nginx_reload_config; then
  if ! restore_config; then
    if test "$had_config" -eq 1; then
      fail 'nginx reload failed; failed to restore previous config'
    fi
    fail 'nginx reload failed; failed to remove rendered config'
  fi
  if ! nginx_test_config; then
    if test "$had_config" -eq 1; then
      fail 'nginx reload failed; previous config restored but failed revalidation'
    fi
    fail 'nginx reload failed; rendered config removed but remaining configuration failed revalidation; no previous config existed'
  fi
  if ! nginx_reload_config; then
    if test "$had_config" -eq 1; then
      fail 'nginx reload failed; previous config restored and revalidated, but recovery reload failed'
    fi
    fail 'nginx reload failed; rendered config removed and remaining configuration revalidated, but recovery reload failed; no previous config existed'
  fi
  if test "$had_config" -eq 1; then
    fail 'nginx reload signal command failed; previous config restored and revalidated; recovery reload signal command accepted by selected Nginx binary; worker replacement not verified'
  fi
  fail 'nginx reload signal command failed; rendered config removed and remaining configuration revalidated; recovery reload signal command accepted by selected Nginx binary; worker replacement not verified; no previous config existed'
fi

printf 'bootstrap complete: root=%s user=%s server_name=%s\n' \
  "$DEPLOY_ROOT" "$DEPLOY_USER" "$SERVER_NAME"
printf 'Nginx reload signal command accepted by selected Nginx binary; configuration application is not verified.\n'
printf 'No firewall, sshd, DNS, or certificate files were changed.\n'

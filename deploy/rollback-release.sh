#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SMOKE_SCRIPT=${SMOKE_SCRIPT:-$SCRIPT_DIR/smoke.sh}

DEPLOY_ROOT=${DEPLOY_ROOT:-/srv/cs-baoyan-ddl}
RUN_TOKEN=${RUN_TOKEN:-}
FAILED_RELEASE_SHA=${FAILED_RELEASE_SHA:-}
TARGET_RELEASE_SHA=${TARGET_RELEASE_SHA:-}
SMOKE_URL=${SMOKE_URL:-http://127.0.0.1}
SMOKE_HOST_HEADER=${SMOKE_HOST_HEADER:-}

fail() {
  printf 'rollback failed: %s\n' "$*" >&2
  exit 1
}

valid_sha() {
  local value=$1
  case "$value" in
    *[!0-9a-f]*|'') return 1 ;;
  esac
  test "${#value}" -eq 40
}

if test -n "$TARGET_RELEASE_SHA"; then
  test -z "$FAILED_RELEASE_SHA" \
    || fail 'TARGET_RELEASE_SHA and FAILED_RELEASE_SHA are mutually exclusive'
  valid_sha "$TARGET_RELEASE_SHA" \
    || fail 'TARGET_RELEASE_SHA must be exactly 40 lowercase hexadecimal characters'
  mode=manual
  link_token=${RUN_TOKEN:-manual-$$}
else
  test -n "$RUN_TOKEN" || fail 'RUN_TOKEN is required for transaction rollback'
  valid_sha "$FAILED_RELEASE_SHA" \
    || fail 'FAILED_RELEASE_SHA must be exactly 40 lowercase hexadecimal characters'
  mode=transaction
  link_token=$RUN_TOKEN
fi
case "$link_token" in
  *[!A-Za-z0-9._-]*|'') fail 'RUN_TOKEN contains unsafe characters' ;;
esac

for command_name in flock python3 curl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is missing: $command_name"
done
test -f "$SMOKE_SCRIPT" || fail "smoke script not found: $SMOKE_SCRIPT"

DEPLOY_ROOT=$(python3 - "$DEPLOY_ROOT" <<'PY'
import os
import sys

path = os.path.realpath(sys.argv[1])
if not os.path.isabs(path) or path == "/":
    raise SystemExit("DEPLOY_ROOT must be an absolute non-root path")
print(path)
PY
) || fail 'DEPLOY_ROOT must be an absolute non-root path'

releases_dir=$DEPLOY_ROOT/releases
shared_dir=$DEPLOY_ROOT/shared
transactions_dir=$DEPLOY_ROOT/transactions
current_link=$DEPLOY_ROOT/current
for required_dir in "$releases_dir" "$shared_dir" "$transactions_dir"; do
  test -d "$required_dir" || fail "required deployment directory is missing: $required_dir"
  test ! -L "$required_dir" || fail "deployment directory must not be a symlink: $required_dir"
done

exec 9>"$shared_dir/deploy.lock"
flock -x 9

fsync_path() {
  python3 - "$1" "$2" <<'PY'
import os
import stat
import sys

path, expected_type = sys.argv[1:]
metadata = os.lstat(path)
if stat.S_ISLNK(metadata.st_mode):
    raise SystemExit(f"refusing to fsync symlink: {path}")
flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
if expected_type == "file":
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"fsync target is not a regular file: {path}")
elif expected_type == "directory":
    if not stat.S_ISDIR(metadata.st_mode):
        raise SystemExit(f"fsync target is not a directory: {path}")
    flags |= getattr(os, "O_DIRECTORY", 0)
else:
    raise SystemExit("invalid fsync target type")

descriptor = os.open(path, flags)
try:
    opened = os.fstat(descriptor)
    if expected_type == "file" and not stat.S_ISREG(opened.st_mode):
        raise SystemExit(f"opened fsync target is not a regular file: {path}")
    if expected_type == "directory" and not stat.S_ISDIR(opened.st_mode):
        raise SystemExit(f"opened fsync target is not a directory: {path}")
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

fsync_regular_file() {
  fsync_path "$1" file
}

fsync_directory() {
  fsync_path "$1" directory
}

atomic_replace() {
  python3 - "$1" "$2" <<'PY'
import os
import sys
os.replace(sys.argv[1], sys.argv[2])
PY
}

read_archive_marker() {
  python3 - "$1/.archive-sha256" <<'PY'
import os
import re
import stat
import sys

path = sys.argv[1]
try:
    metadata = os.lstat(path)
except FileNotFoundError:
    raise SystemExit(1)
if not stat.S_ISREG(metadata.st_mode):
    raise SystemExit(1)
with open(path, "rb") as handle:
    raw = handle.read()
if not re.fullmatch(rb"[0-9a-f]{64}\n", raw):
    raise SystemExit(1)
sys.stdout.write(raw[:-1].decode("ascii"))
PY
}

validate_release_path() {
  local candidate=$1
  local canonical
  local parent
  local name

  test -d "$candidate" || return 1
  test ! -L "$candidate" || return 1
  canonical=$(python3 - "$candidate" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
) || return 1
  test "$canonical" = "$candidate" || return 1
  parent=$(dirname -- "$candidate")
  name=$(basename -- "$candidate")
  test "$parent" = "$releases_dir" || return 1
  valid_sha "$name" || return 1
  read_archive_marker "$candidate" >/dev/null
}

current_target() {
  if test -L "$current_link"; then
    python3 - "$current_link" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
  elif test -e "$current_link"; then
    return 2
  else
    return 1
  fi
}

atomic_link() {
  local target=$1
  local temporary=$DEPLOY_ROOT/.current.$link_token

  validate_release_path "$target" || fail "refusing release path outside releases: $target"
  rm -f -- "$temporary"
  ln -s -- "$target" "$temporary"
  fsync_directory "$DEPLOY_ROOT"
  atomic_replace "$temporary" "$current_link"
  fsync_directory "$DEPLOY_ROOT"
}

remove_current_link() {
  if test -L "$current_link"; then
    rm -f -- "$current_link"
    fsync_directory "$DEPLOY_ROOT"
  elif test -e "$current_link"; then
    fail 'refusing to remove non-symlink current path'
  fi
}

smoke_current_as() {
  local target=$1
  local identity
  local release_sha
  local snapshot_id
  local data_hash

  identity=$(python3 - "$target/release.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for key in ("releaseSha", "snapshotId", "dataHash"):
    field = value.get(key)
    if not isinstance(field, str) or not field or any(char in field for char in "\t\r\n"):
        raise SystemExit(f"invalid {key} in release.json")
if not __import__("re").fullmatch(r"[0-9a-f]{40}", value["releaseSha"]):
    raise SystemExit("invalid releaseSha in release.json")
if not __import__("re").fullmatch(r"[0-9a-f]{64}", value["dataHash"]):
    raise SystemExit("invalid dataHash in release.json")
print("\t".join((value["releaseSha"], value["snapshotId"], value["dataHash"])))
PY
) || return 1
  IFS=$'\t' read -r release_sha snapshot_id data_hash <<<"$identity"
  test "$release_sha" = "$(basename -- "$target")" || return 1
  SMOKE_URL="$SMOKE_URL" \
  SMOKE_HOST_HEADER="$SMOKE_HOST_HEADER" \
  EXPECTED_RELEASE_SHA="$release_sha" \
  EXPECTED_SNAPSHOT_ID="$snapshot_id" \
  EXPECTED_DATA_HASH="$data_hash" \
    bash "$SMOKE_SCRIPT"
}

read_transaction_field() {
  local field=$1
  python3 - "$transaction/$field" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
try:
    metadata = os.lstat(path)
except FileNotFoundError:
    raise SystemExit(1)
if not stat.S_ISREG(metadata.st_mode):
    raise SystemExit(1)
with open(path, "rb") as handle:
    raw = handle.read()
if raw.count(b"\n") != 1 or not raw.endswith(b"\n") or b"\x00" in raw:
    raise SystemExit(1)
try:
    value = raw[:-1].decode("utf-8")
except UnicodeDecodeError:
    raise SystemExit(1)
sys.stdout.write(value)
PY
}

write_transaction_state() {
  local value=$1
  local temporary=$transaction/.state.$link_token.$$
  case "$value" in
    compensated) ;;
    *) fail "invalid transaction state: $value" ;;
  esac
  printf '%s\n' "$value" > "$temporary"
  chmod 0600 "$temporary"
  fsync_regular_file "$temporary"
  fsync_directory "$transaction"
  atomic_replace "$temporary" "$transaction/state"
  fsync_directory "$transaction"
}

if test "$mode" = transaction; then
  transaction=$transactions_dir/$RUN_TOKEN
  failed_release=$releases_dir/$FAILED_RELEASE_SHA
  if test ! -e "$transaction" && test ! -L "$transaction"; then
    served=
    current_status=0
    if served=$(current_target); then
      validate_release_path "$served" \
        || fail 'current link points outside DEPLOY_ROOT/releases or lacks a valid checksum marker'
      test "$served" != "$failed_release" \
        || fail 'transaction is missing while the failed release is still current'
    else
      current_status=$?
      test "$current_status" -ne 2 || fail 'current exists but is not a symlink'
    fi
    printf 'transaction rollback already reconciled or never activated: %s\n' "$RUN_TOKEN"
    exit 0
  fi
  test -d "$transaction" && test ! -L "$transaction" \
    || fail "transaction not found or unsafe: $RUN_TOKEN"

  recorded_release=$(read_transaction_field release) \
    || fail 'unsafe transaction release file; expected one regular non-symlink file'
  previous=$(read_transaction_field previous) \
    || fail 'unsafe transaction previous file; expected one regular non-symlink file'
  recorded_archive_sha=$(read_transaction_field archive-sha256) \
    || fail 'unsafe transaction archive-sha256 file; expected one regular non-symlink file'
  recorded_state=$(read_transaction_field state) \
    || fail 'unsafe transaction state file; expected one regular non-symlink file'
  test "$recorded_release" = "$failed_release" \
    || fail 'transaction release does not match FAILED_RELEASE_SHA'
  case "$recorded_archive_sha" in
    *[!0-9a-f]*|'') fail 'transaction archive-sha256 is not a strict SHA-256 value' ;;
  esac
  test "${#recorded_archive_sha}" -eq 64 \
    || fail 'transaction archive-sha256 is not a strict SHA-256 value'
  case "$recorded_state" in
    prepared|switched|activated|compensated) ;;
    *) fail 'transaction state is invalid' ;;
  esac
  validate_release_path "$failed_release" \
    || fail 'failed release path is unsafe or lacks a valid checksum marker'
  failed_archive_sha=$(read_archive_marker "$failed_release") \
    || fail 'failed release has no valid internal archive checksum marker'
  test "$failed_archive_sha" = "$recorded_archive_sha" \
    || fail 'transaction archive-sha256 does not match the failed release marker'
  if test -n "$previous"; then
    validate_release_path "$previous" \
      || fail 'transaction previous path is outside DEPLOY_ROOT/releases or lacks a valid checksum marker'
  fi

  served=
  current_status=0
  if served=$(current_target); then
    validate_release_path "$served" \
      || fail 'current link points outside DEPLOY_ROOT/releases'
  else
    current_status=$?
    test "$current_status" -ne 2 || fail 'current exists but is not a symlink'
  fi

  if test -n "$previous"; then
    if test "$served" = "$failed_release"; then
      atomic_link "$previous"
    elif test "$current_status" -eq 1; then
      atomic_link "$previous"
    elif test "$served" != "$previous"; then
      fail 'current no longer matches the failed or previous transaction release'
    fi
    smoke_current_as "$previous" \
      || fail 'previous release was restored but failed local smoke'
  else
    if test "$served" = "$failed_release"; then
      remove_current_link
    elif test "$current_status" -ne 1; then
      fail 'first-release transaction no longer owns current'
    fi
  fi
  write_transaction_state compensated
  printf 'transaction rollback completed: %s\n' "$RUN_TOKEN"
  exit 0
fi

target=$releases_dir/$TARGET_RELEASE_SHA
validate_release_path "$target" || fail "explicit rollback target is not a safe release: $TARGET_RELEASE_SHA"
previous=
if previous_value=$(current_target); then
  previous=$previous_value
  validate_release_path "$previous" \
    || fail 'current link points outside DEPLOY_ROOT/releases'
else
  current_status=$?
  test "$current_status" -eq 1 || fail 'current exists but is not a symlink'
fi

if test "$previous" = "$target"; then
  smoke_current_as "$target" || fail 'selected release is current but failed local smoke'
  printf 'manual rollback target already active: %s\n' "$TARGET_RELEASE_SHA"
  exit 0
fi

switched=0
restore_manual_on_exit() {
  local status=$?
  trap - EXIT
  if test "$status" -ne 0 && test "$switched" -eq 1; then
    if test -n "$previous"; then
      atomic_link "$previous"
      if ! smoke_current_as "$previous"; then
        printf 'manual rollback compensation smoke failed for %s\n' "$previous" >&2
      fi
    else
      remove_current_link
    fi
  fi
  exit "$status"
}
trap restore_manual_on_exit EXIT

atomic_link "$target"
switched=1
smoke_current_as "$target" || fail 'selected rollback release failed local smoke'
trap - EXIT
printf 'manual rollback activated explicit release: %s\n' "$TARGET_RELEASE_SHA"

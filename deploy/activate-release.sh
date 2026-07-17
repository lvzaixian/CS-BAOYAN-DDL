#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SMOKE_SCRIPT=${SMOKE_SCRIPT:-$SCRIPT_DIR/smoke.sh}

DEPLOY_ROOT=${DEPLOY_ROOT:-/srv/cs-baoyan-ddl}
RUN_TOKEN=${RUN_TOKEN:-}
RELEASE_SHA=${RELEASE_SHA:-}
ARCHIVE_SHA=${ARCHIVE_SHA:-}
EXPECTED_SNAPSHOT_ID=${EXPECTED_SNAPSHOT_ID:-}
EXPECTED_DATA_HASH=${EXPECTED_DATA_HASH:-}
SMOKE_URL=${SMOKE_URL:-http://127.0.0.1}
SMOKE_HOST_HEADER=${SMOKE_HOST_HEADER:-}

readonly ARCHIVE_MAX_BYTES_HARD=67108864
readonly ARCHIVE_MAX_MEMBERS_HARD=10000
readonly ARCHIVE_MAX_FILE_BYTES_HARD=16777216
readonly ARCHIVE_MAX_EXPANDED_BYTES_HARD=134217728
readonly ARCHIVE_MAX_PATH_BYTES_HARD=256
readonly ARCHIVE_MIN_FREE_BYTES_HARD=67108864
readonly ARCHIVE_MAX_BYTES=${ARCHIVE_MAX_BYTES-$ARCHIVE_MAX_BYTES_HARD}
readonly ARCHIVE_MAX_MEMBERS=${ARCHIVE_MAX_MEMBERS-$ARCHIVE_MAX_MEMBERS_HARD}
readonly ARCHIVE_MAX_FILE_BYTES=${ARCHIVE_MAX_FILE_BYTES-$ARCHIVE_MAX_FILE_BYTES_HARD}
readonly ARCHIVE_MAX_EXPANDED_BYTES=${ARCHIVE_MAX_EXPANDED_BYTES-$ARCHIVE_MAX_EXPANDED_BYTES_HARD}
readonly ARCHIVE_MAX_PATH_BYTES=${ARCHIVE_MAX_PATH_BYTES-$ARCHIVE_MAX_PATH_BYTES_HARD}
readonly ARCHIVE_MIN_FREE_BYTES=${ARCHIVE_MIN_FREE_BYTES-$ARCHIVE_MIN_FREE_BYTES_HARD}

fail() {
  printf 'activate failed: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local name=$1
  local value=$2
  test -n "$value" || fail "$name is required"
}

require_value RUN_TOKEN "$RUN_TOKEN"
require_value RELEASE_SHA "$RELEASE_SHA"
require_value ARCHIVE_SHA "$ARCHIVE_SHA"
require_value EXPECTED_SNAPSHOT_ID "$EXPECTED_SNAPSHOT_ID"
require_value EXPECTED_DATA_HASH "$EXPECTED_DATA_HASH"

case "$RUN_TOKEN" in
  *[!A-Za-z0-9._-]*|'') fail 'RUN_TOKEN contains unsafe characters' ;;
esac
case "$RELEASE_SHA" in
  *[!0-9a-f]*|'') fail 'RELEASE_SHA must be exactly 40 lowercase hexadecimal characters' ;;
esac
test "${#RELEASE_SHA}" -eq 40 \
  || fail 'RELEASE_SHA must be exactly 40 lowercase hexadecimal characters'
case "$ARCHIVE_SHA" in
  *[!0-9a-f]*|'') fail 'ARCHIVE_SHA must be exactly 64 lowercase hexadecimal characters' ;;
esac
test "${#ARCHIVE_SHA}" -eq 64 \
  || fail 'ARCHIVE_SHA must be exactly 64 lowercase hexadecimal characters'
case "$EXPECTED_DATA_HASH" in
  *[!0-9a-f]*|'') fail 'EXPECTED_DATA_HASH must be exactly 64 lowercase hexadecimal characters' ;;
esac
test "${#EXPECTED_DATA_HASH}" -eq 64 \
  || fail 'EXPECTED_DATA_HASH must be exactly 64 lowercase hexadecimal characters'
if [[ "$EXPECTED_SNAPSHOT_ID" == *$'\n'* || "$EXPECTED_SNAPSHOT_ID" == *$'\r'* \
  || "$EXPECTED_SNAPSHOT_ID" == *$'\t'* ]]; then
  fail 'EXPECTED_SNAPSHOT_ID must not contain tabs or newlines'
fi

for command_name in flock sha256sum tar python3 curl mktemp; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is missing: $command_name"
done
test -f "$SMOKE_SCRIPT" || fail "smoke script not found: $SMOKE_SCRIPT"

python3 - \
  "$ARCHIVE_MAX_BYTES" "$ARCHIVE_MAX_BYTES_HARD" \
  "$ARCHIVE_MAX_MEMBERS" "$ARCHIVE_MAX_MEMBERS_HARD" \
  "$ARCHIVE_MAX_FILE_BYTES" "$ARCHIVE_MAX_FILE_BYTES_HARD" \
  "$ARCHIVE_MAX_EXPANDED_BYTES" "$ARCHIVE_MAX_EXPANDED_BYTES_HARD" \
  "$ARCHIVE_MAX_PATH_BYTES" "$ARCHIVE_MAX_PATH_BYTES_HARD" \
  "$ARCHIVE_MIN_FREE_BYTES" "$ARCHIVE_MIN_FREE_BYTES_HARD" <<'PY'
import re
import sys

arguments = sys.argv[1:]
maximums = (
    ("ARCHIVE_MAX_BYTES", arguments[0], arguments[1]),
    ("ARCHIVE_MAX_MEMBERS", arguments[2], arguments[3]),
    ("ARCHIVE_MAX_FILE_BYTES", arguments[4], arguments[5]),
    ("ARCHIVE_MAX_EXPANDED_BYTES", arguments[6], arguments[7]),
    ("ARCHIVE_MAX_PATH_BYTES", arguments[8], arguments[9]),
)
for name, raw_value, raw_hard_limit in maximums:
    if not re.fullmatch(r"[1-9][0-9]*", raw_value):
        raise SystemExit(f"{name} must be a positive decimal integer")
    if int(raw_value) > int(raw_hard_limit):
        raise SystemExit(f"{name} must not exceed its hard ceiling {raw_hard_limit}")

minimum_name = "ARCHIVE_MIN_FREE_BYTES"
minimum_value, minimum_floor = arguments[10:]
if not re.fullmatch(r"[1-9][0-9]*", minimum_value):
    raise SystemExit(f"{minimum_name} must be a positive decimal integer")
if int(minimum_value) < int(minimum_floor):
    raise SystemExit(f"{minimum_name} must not be lower than its hard floor {minimum_floor}")
PY

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
staging_dir=$shared_dir/staging/$RUN_TOKEN
archive=$staging_dir/release.tar.gz
archive_checksum=$archive.sha256
release=$releases_dir/$RELEASE_SHA
transaction=$transactions_dir/$RUN_TOKEN
current_link=$DEPLOY_ROOT/current

for required_dir in "$releases_dir" "$shared_dir" "$transactions_dir"; do
  test -d "$required_dir" || fail "required deployment directory is missing: $required_dir"
  test ! -L "$required_dir" || fail "deployment directory must not be a symlink: $required_dir"
done
test -d "$staging_dir" || fail "unique staging directory is missing: $staging_dir"
test ! -L "$staging_dir" || fail 'staging directory must not be a symlink'
test -f "$archive" && test ! -L "$archive" || fail 'staged release archive is missing or unsafe'
test -f "$archive_checksum" && test ! -L "$archive_checksum" \
  || fail 'staged archive checksum is missing or unsafe'

exec 9>"$shared_dir/deploy.lock"
flock -x 9

archive_size=$(python3 - "$archive" <<'PY'
import os
import sys
print(os.path.getsize(sys.argv[1]))
PY
)
test "$archive_size" -le "$ARCHIVE_MAX_BYTES" \
  || fail "compressed archive size exceeds limit: $archive_size > $ARCHIVE_MAX_BYTES"

uploaded_line=$(cat "$archive_checksum")
test "$uploaded_line" = "$ARCHIVE_SHA  release.tar.gz" \
  || fail 'uploaded checksum file does not match ARCHIVE_SHA and release.tar.gz'
(
  cd "$staging_dir"
  sha256sum -c release.tar.gz.sha256 >/dev/null
) || fail 'uploaded archive SHA-256 verification failed'
actual_archive_sha=$(sha256sum "$archive" | awk '{print $1}')
test "$actual_archive_sha" = "$ARCHIVE_SHA" \
  || fail 'uploaded archive SHA-256 does not match ARCHIVE_SHA'

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

fsync_tree() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

root = sys.argv[1]
root_metadata = os.lstat(root)
if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
    raise SystemExit("fsync tree root must be a real directory")


def sync_path(path, expect_directory):
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(f"refusing symlink in fsync tree: {path}")
    if expect_directory:
        if not stat.S_ISDIR(metadata.st_mode):
            raise SystemExit(f"fsync tree entry is not a directory: {path}")
    elif not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f"fsync tree entry is not a regular file: {path}")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if expect_directory:
        flags |= getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if expect_directory and not stat.S_ISDIR(opened.st_mode):
            raise SystemExit(f"opened fsync tree entry is not a directory: {path}")
        if not expect_directory and not stat.S_ISREG(opened.st_mode):
            raise SystemExit(f"opened fsync tree entry is not a regular file: {path}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


for current, directories, files in os.walk(root, topdown=False, followlinks=False):
    for name in files:
        sync_path(os.path.join(current, name), False)
    for name in directories:
        sync_path(os.path.join(current, name), True)
    sync_path(current, True)
PY
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
  case "$name" in
    *[!0-9a-f]*|'') return 1 ;;
  esac
  test "${#name}" -eq 40 || return 1
  read_archive_marker "$candidate" >/dev/null
}

current_target() {
  if test -L "$current_link"; then
    python3 - "$current_link" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
    return 0
  elif test -e "$current_link"; then
    return 2
  fi
  return 1
}

atomic_link() {
  local target=$1
  local temporary=$DEPLOY_ROOT/.current.$RUN_TOKEN

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

read_identity() {
  local target=$1
  python3 - "$target/release.json" <<'PY'
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
}

smoke_current_as() {
  local target=$1
  local identity
  local release_sha
  local snapshot_id
  local data_hash

  identity=$(read_identity "$target") || return 1
  IFS=$'\t' read -r release_sha snapshot_id data_hash <<<"$identity"
  test "$release_sha" = "$(basename -- "$target")" || return 1
  SMOKE_URL="$SMOKE_URL" \
  SMOKE_HOST_HEADER="$SMOKE_HOST_HEADER" \
  EXPECTED_RELEASE_SHA="$release_sha" \
  EXPECTED_SNAPSHOT_ID="$snapshot_id" \
  EXPECTED_DATA_HASH="$data_hash" \
    bash "$SMOKE_SCRIPT"
}

run_preview_smoke() {
  local target=$1
  local port_file=$staging_dir/preview.port
  local log_file=$staging_dir/preview.log
  local preview_pid
  local port=
  local attempt
  local result=0

  rm -f -- "$port_file" "$log_file"
  python3 - "$target" "$port_file" >"$log_file" 2>&1 <<'PY' &
import http.server
import os
import sys
from urllib.parse import urlsplit

root, port_file = sys.argv[1:]


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def send_head(self):
        request_path = urlsplit(self.path).path
        translated = self.translate_path(request_path)
        if not os.path.exists(translated) and not request_path.startswith(("/assets/", "/data/")):
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, format, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SpaHandler)
with open(port_file, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_address[1]))
server.serve_forever()
PY
  preview_pid=$!

  attempt=1
  while test "$attempt" -le 50; do
    if test -s "$port_file"; then
      port=$(cat "$port_file")
      break
    fi
    if ! kill -0 "$preview_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done

  if test -z "$port"; then
    result=1
  elif ! SMOKE_URL="http://127.0.0.1:$port" \
    SMOKE_HOST_HEADER= \
    EXPECTED_RELEASE_SHA="$RELEASE_SHA" \
    EXPECTED_SNAPSHOT_ID="$EXPECTED_SNAPSHOT_ID" \
    EXPECTED_DATA_HASH="$EXPECTED_DATA_HASH" \
      bash "$SMOKE_SCRIPT"; then
    result=1
  fi

  kill "$preview_pid" 2>/dev/null || true
  wait "$preview_pid" 2>/dev/null || true
  if test "$result" -ne 0; then
    test ! -s "$log_file" || cat "$log_file" >&2
    return 1
  fi
}

if test -e "$release" || test -L "$release"; then
  validate_release_path "$release" \
    || fail 'existing release path is not a safe versioned read-only release directory'
  recorded_archive_sha=$(read_archive_marker "$release") \
    || fail 'existing release has no valid internal archive checksum marker'
  test "$recorded_archive_sha" = "$ARCHIVE_SHA" \
    || fail "archive checksum conflict for existing release $RELEASE_SHA"
  run_preview_smoke "$release" || fail 'existing release failed pre-activation smoke'
else
  python3 - \
    "$archive" "$ARCHIVE_MAX_MEMBERS" "$ARCHIVE_MAX_FILE_BYTES" \
    "$ARCHIVE_MAX_EXPANDED_BYTES" "$ARCHIVE_MAX_PATH_BYTES" <<'PY'
import gzip
import posixpath
import sys

archive = sys.argv[1]
max_members, max_file_bytes, max_payload_bytes, max_path_bytes = map(int, sys.argv[2:])
zero_block = b"\0" * 512


def reject(message):
    raise SystemExit(f"raw tar preflight rejected archive: {message}")


def parse_octal(field, label, member_index):
    if field and field[0] & 0x80:
        reject(f"base-256 {label} is forbidden at member {member_index}")
    value = field.rstrip(b"\0 ").lstrip(b" ")
    if not value:
        return 0
    if any(byte < ord("0") or byte > ord("7") for byte in value):
        reject(f"invalid {label} at member {member_index}")
    return int(value, 8)


def drain_exact(source, length, member_index):
    remaining = length
    while remaining:
        chunk = source.read(min(64 * 1024, remaining))
        if not chunk:
            reject(f"truncated payload at member {member_index}")
        remaining -= len(chunk)


member_count = 0
payload_bytes = 0
with gzip.open(archive, "rb") as source:
    while True:
        header = source.read(512)
        if not header:
            reject("missing tar end marker")
        if len(header) != 512:
            reject("truncated 512-byte tar header")
        if header == zero_block:
            second_end_block = source.read(512)
            if second_end_block != zero_block:
                reject("invalid tar end marker")
            break

        member_count += 1
        if member_count > max_members:
            reject(f"member count exceeds limit: {member_count} > {max_members}")

        stored_checksum = parse_octal(header[148:156], "checksum", member_count)
        calculated_checksum = sum(header[:148]) + (8 * ord(" ")) + sum(header[156:])
        if stored_checksum != calculated_checksum:
            reject(f"checksum mismatch at member {member_count}")

        typeflag = header[156:157]
        if typeflag not in (b"\0", b"0", b"5"):
            reject(f"raw tar header type is forbidden at member {member_count}")

        size = parse_octal(header[124:136], "size", member_count)
        if typeflag == b"5" and size != 0:
            reject(f"directory payload is forbidden at member {member_count}")
        if typeflag in (b"\0", b"0") and size > max_file_bytes:
            reject(f"file size exceeds limit at member {member_count}: {size} > {max_file_bytes}")

        name = header[:100].split(b"\0", 1)[0]
        prefix = header[345:500].split(b"\0", 1)[0]
        path_bytes = prefix + (b"/" if prefix and name else b"") + name
        if not path_bytes:
            reject(f"empty path at member {member_count}")
        if len(path_bytes) > max_path_bytes:
            reject(
                f"path length exceeds limit at member {member_count}: "
                f"{len(path_bytes)} > {max_path_bytes}"
            )
        try:
            path = path_bytes.decode("utf-8")
        except UnicodeDecodeError:
            reject(f"path is not UTF-8 at member {member_count}")
        normalized = posixpath.normpath(path)
        if path.startswith("/") or normalized == ".." or normalized.startswith("../"):
            reject(f"path escapes archive root at member {member_count}")
        if typeflag in (b"\0", b"0") and normalized == ".":
            reject(f"file path is unsafe at member {member_count}")

        payload_bytes += size
        if payload_bytes > max_payload_bytes:
            reject(
                f"expanded size exceeds limit at member {member_count}: "
                f"{payload_bytes} > {max_payload_bytes}"
            )
        padded_size = ((size + 511) // 512) * 512
        drain_exact(source, padded_size, member_count)
PY

  extract_dir=$staging_dir/extracted
  test ! -e "$extract_dir" && test ! -L "$extract_dir" \
    || fail 'staging extraction path already exists'
  mkdir -- "$extract_dir"
  python3 - \
    "$archive" "$extract_dir" \
    "$ARCHIVE_MAX_MEMBERS" "$ARCHIVE_MAX_FILE_BYTES" \
    "$ARCHIVE_MAX_EXPANDED_BYTES" "$ARCHIVE_MAX_PATH_BYTES" \
    "$ARCHIVE_MIN_FREE_BYTES" <<'PY'
import os
import shutil
import sys
import tarfile

archive, destination = sys.argv[1:3]
max_members, max_file_bytes, max_expanded_bytes, max_path_bytes, min_free_bytes = map(
    int, sys.argv[3:]
)
destination = os.path.realpath(destination)
member_count = 0
expanded_bytes = 0
with tarfile.open(archive, mode="r|gz") as bundle:
    for member in bundle:
        member_count += 1
        if member_count > max_members:
            raise SystemExit(
                f"archive member count exceeds limit: {member_count} > {max_members}"
            )

        if not member.name:
            raise SystemExit("archive member path is empty")
        try:
            member_path_bytes = member.name.encode("utf-8")
        except UnicodeEncodeError:
            raise SystemExit(f"archive member path is not UTF-8 at member {member_count}")
        if len(member_path_bytes) > max_path_bytes:
            raise SystemExit(
                f"archive member path length exceeds limit at member {member_count}: "
                f"{len(member_path_bytes)} > {max_path_bytes}"
            )
        target = os.path.realpath(os.path.join(destination, member.name))
        if os.path.commonpath((destination, target)) != destination:
            raise SystemExit(f"archive member escapes extraction root: {member.name}")
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"archive member type is forbidden: {member.name}")

        if member.isdir():
            if member.size != 0:
                raise SystemExit(
                    f"archive directory has nonzero size: {member.name}: {member.size}"
                )
            os.makedirs(target, exist_ok=True)
            if not os.path.isdir(target) or os.path.islink(target):
                raise SystemExit(f"archive directory path is unsafe: {member.name}")
            continue

        if target == destination:
            raise SystemExit(f"archive file path is unsafe: {member.name}")
        if member.size < 0:
            raise SystemExit(f"archive member file size is invalid: {member.name}")
        if member.size > max_file_bytes:
            raise SystemExit(
                f"archive member file size exceeds limit: {member.name}: "
                f"{member.size} > {max_file_bytes}"
            )
        expanded_bytes += member.size
        if expanded_bytes > max_expanded_bytes:
            raise SystemExit(
                f"archive expanded size exceeds limit: "
                f"{expanded_bytes} > {max_expanded_bytes}"
            )

        free_bytes = shutil.disk_usage(destination).free
        required_free_bytes = min_free_bytes + member.size
        if free_bytes < required_free_bytes:
            raise SystemExit(
                f"free disk space is below required extraction reserve: "
                f"{free_bytes} < {required_free_bytes}"
            )

        parent = os.path.dirname(target)
        os.makedirs(parent, exist_ok=True)
        if not os.path.isdir(parent) or os.path.islink(parent):
            raise SystemExit(f"archive member parent path is unsafe: {member.name}")
        source = bundle.extractfile(member)
        if source is None:
            raise SystemExit(f"archive member data is unavailable: {member.name}")
        try:
            with open(target, "xb") as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise SystemExit(f"archive member data is truncated: {member.name}")
                    output.write(chunk)
                    remaining -= len(chunk)
        finally:
            source.close()
PY
  test -s "$extract_dir/index.html" || fail 'release archive has no non-empty index.html'
  test -s "$extract_dir/release.json" || fail 'release archive has no non-empty release.json'
  run_preview_smoke "$extract_dir" || fail 'new release failed pre-activation smoke'
  test ! -e "$release" && test ! -L "$release" \
    || fail 'release appeared while the deployment lock was held'
  chmod -R u=rwX,go=rX "$extract_dir"
  printf '%s\n' "$ARCHIVE_SHA" > "$extract_dir/.archive-sha256"
  chmod 0444 "$extract_dir/.archive-sha256"
  chmod -R a-w "$extract_dir"
  fsync_tree "$extract_dir"
  chmod u+w "$extract_dir"
  fsync_directory "$extract_dir"
  mv -- "$extract_dir" "$release"
  chmod a-w "$release"
  fsync_directory "$release"
  fsync_directory "$releases_dir"
  fsync_directory "$staging_dir"
fi

test ! -e "$transaction" && test ! -L "$transaction" \
  || fail "transaction already exists for RUN_TOKEN $RUN_TOKEN"
previous=
if current_value=$(current_target); then
  previous=$current_value
  validate_release_path "$previous" \
    || fail "current link points outside DEPLOY_ROOT/releases: $previous"
else
  current_status=$?
  test "$current_status" -eq 1 || fail 'current exists but is not a symlink'
fi
transaction_temp=$(mktemp -d "$transactions_dir/.$RUN_TOKEN.XXXXXX")
cleanup_transaction_temp() {
  if test -n "${transaction_temp:-}" && test -d "$transaction_temp" \
    && test ! -L "$transaction_temp"; then
    rm -rf -- "$transaction_temp"
  fi
}
trap cleanup_transaction_temp EXIT
chmod 0700 "$transaction_temp"
printf '%s\n' "$release" > "$transaction_temp/release"
printf '%s\n' "$previous" > "$transaction_temp/previous"
printf '%s\n' "$ARCHIVE_SHA" > "$transaction_temp/archive-sha256"
printf 'prepared\n' > "$transaction_temp/state"
chmod 0400 "$transaction_temp/release" "$transaction_temp/previous" \
  "$transaction_temp/archive-sha256"
chmod 0600 "$transaction_temp/state"
fsync_regular_file "$transaction_temp/release"
fsync_regular_file "$transaction_temp/previous"
fsync_regular_file "$transaction_temp/archive-sha256"
fsync_regular_file "$transaction_temp/state"
fsync_directory "$transaction_temp"
mv -- "$transaction_temp" "$transaction"
fsync_directory "$transactions_dir"
transaction_temp=
trap - EXIT

write_transaction_state() {
  local value=$1
  local temporary=$transaction/.state.$RUN_TOKEN.$$
  case "$value" in
    prepared|switched|activated|compensated) ;;
    *) fail "invalid transaction state: $value" ;;
  esac
  printf '%s\n' "$value" > "$temporary"
  chmod 0600 "$temporary"
  fsync_regular_file "$temporary"
  fsync_directory "$transaction"
  atomic_replace "$temporary" "$transaction/state"
  fsync_directory "$transaction"
}

activation_attempted=0
compensate_on_exit() {
  local status=$?
  local served=
  local current_status=0
  local reconciled=0
  trap - EXIT
  if test "$status" -ne 0 && test "$activation_attempted" -eq 1; then
    if served=$(current_target); then
      if test "$served" = "$release"; then
        if test -n "$previous"; then
          atomic_link "$previous"
        else
          remove_current_link
        fi
      elif test -n "$previous" && test "$served" != "$previous"; then
        printf 'activate compensation refused unexpected current target %s\n' "$served" >&2
        reconciled=1
      elif test -z "$previous"; then
        printf 'activate compensation refused unexpected current target %s\n' "$served" >&2
        reconciled=1
      fi
    else
      current_status=$?
      if test "$current_status" -eq 2; then
        printf 'activate compensation found a non-symlink current path\n' >&2
        reconciled=1
      elif test -n "$previous"; then
        atomic_link "$previous"
      fi
    fi
    if test "$reconciled" -eq 0 && test -n "$previous"; then
      if ! smoke_current_as "$previous"; then
        printf 'activate compensation smoke failed for previous release %s\n' "$previous" >&2
        reconciled=1
      fi
    fi
    if test "$reconciled" -eq 0; then
      write_transaction_state compensated
    fi
  fi
  exit "$status"
}
trap compensate_on_exit EXIT

activation_attempted=1
atomic_link "$release"
write_transaction_state switched
smoke_current_as "$release" || fail 'activated release failed local smoke'
write_transaction_state activated
trap - EXIT

printf 'activated release %s (transaction %s)\n' "$RELEASE_SHA" "$RUN_TOKEN"

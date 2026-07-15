#!/usr/bin/env bash
set -euo pipefail

SMOKE_URL=${SMOKE_URL:-${1:-}}
SMOKE_HOST_HEADER=${SMOKE_HOST_HEADER:-}
SMOKE_ATTEMPTS=${SMOKE_ATTEMPTS:-5}
SMOKE_RETRY_DELAY=${SMOKE_RETRY_DELAY:-2}
SMOKE_CONNECT_TIMEOUT=${SMOKE_CONNECT_TIMEOUT:-3}
SMOKE_MAX_TIME=${SMOKE_MAX_TIME:-10}
SMOKE_DEEP_PATH=${SMOKE_DEEP_PATH:-__deploy_smoke__/route}
EXPECTED_TITLE=${EXPECTED_TITLE:-CS 保研 DDL · 倒计时}

EXPECTED_RELEASE_SHA=${EXPECTED_RELEASE_SHA:-}
EXPECTED_SNAPSHOT_ID=${EXPECTED_SNAPSHOT_ID:-}
EXPECTED_DATA_HASH=${EXPECTED_DATA_HASH:-}

fail() {
  printf 'smoke failed: %s\n' "$*" >&2
  return 1
}

require_value() {
  local name=$1
  local value=$2
  if test -z "$value"; then
    fail "$name is required"
    exit 2
  fi
}

require_uint() {
  local name=$1
  local value=$2
  case "$value" in
    ''|*[!0-9]*)
      fail "$name must be an unsigned integer"
      exit 2
      ;;
  esac
}

require_value SMOKE_URL "$SMOKE_URL"
require_value EXPECTED_RELEASE_SHA "$EXPECTED_RELEASE_SHA"
require_value EXPECTED_SNAPSHOT_ID "$EXPECTED_SNAPSHOT_ID"
require_value EXPECTED_DATA_HASH "$EXPECTED_DATA_HASH"
require_uint SMOKE_ATTEMPTS "$SMOKE_ATTEMPTS"
require_uint SMOKE_RETRY_DELAY "$SMOKE_RETRY_DELAY"
require_uint SMOKE_CONNECT_TIMEOUT "$SMOKE_CONNECT_TIMEOUT"
require_uint SMOKE_MAX_TIME "$SMOKE_MAX_TIME"

if test "$SMOKE_ATTEMPTS" -lt 1; then
  fail 'SMOKE_ATTEMPTS must be at least 1'
  exit 2
fi
case "$EXPECTED_RELEASE_SHA" in
  *[!0-9a-f]*|'')
    fail 'EXPECTED_RELEASE_SHA must be exactly 40 lowercase hexadecimal characters'
    exit 2
    ;;
esac
if test "${#EXPECTED_RELEASE_SHA}" -ne 40; then
  fail 'EXPECTED_RELEASE_SHA must be exactly 40 lowercase hexadecimal characters'
  exit 2
fi
case "$EXPECTED_DATA_HASH" in
  *[!0-9a-f]*|'')
    fail 'EXPECTED_DATA_HASH must be exactly 64 lowercase hexadecimal characters'
    exit 2
    ;;
esac
if test "${#EXPECTED_DATA_HASH}" -ne 64; then
  fail 'EXPECTED_DATA_HASH must be exactly 64 lowercase hexadecimal characters'
  exit 2
fi
if [[ "$EXPECTED_SNAPSHOT_ID" == *$'\n'* || "$EXPECTED_SNAPSHOT_ID" == *$'\r'* \
  || "$EXPECTED_SNAPSHOT_ID" == *$'\t'* ]]; then
  fail 'EXPECTED_SNAPSHOT_ID must not contain tabs or newlines'
  exit 2
fi
if [[ "$SMOKE_HOST_HEADER" == *$'\n'* || "$SMOKE_HOST_HEADER" == *$'\r'* ]]; then
  fail 'SMOKE_HOST_HEADER must not contain newlines'
  exit 2
fi

for command_name in curl python3 mktemp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "required command is missing: $command_name"
    exit 2
  fi
done

if ! SMOKE_URL=$(python3 - "$SMOKE_URL" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit

raw = sys.argv[1]
try:
    parsed = urlsplit(raw)
    port = parsed.port
except ValueError:
    raise SystemExit(1)

if (
    parsed.scheme.lower() not in {"http", "https"}
    or not parsed.netloc
    or parsed.hostname is None
    or parsed.username is not None
    or parsed.password is not None
    or parsed.path not in {"", "/"}
    or parsed.query
    or parsed.fragment
    or any(character.isspace() or character == "\\" for character in raw)
):
    raise SystemExit(1)

print(urlunsplit((parsed.scheme.lower(), parsed.netloc, "", "", "")))
PY
); then
  fail 'SMOKE_URL must be a credential-free HTTP(S) root origin without path, query, or fragment'
  exit 2
fi
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/cs-baoyan-smoke.XXXXXX")
trap 'rm -rf "$temp_dir"' EXIT

curl_options=(
  --silent
  --show-error
  --proto '=http,https'
  --proto-redir '=http,https'
  --connect-timeout "$SMOKE_CONNECT_TIMEOUT"
  --max-time "$SMOKE_MAX_TIME"
)
if test -n "$SMOKE_HOST_HEADER"; then
  curl_options+=(--header "Host: $SMOKE_HOST_HEADER")
fi

url_for() {
  case "$1" in
    /*) printf '%s%s\n' "$SMOKE_URL" "$1" ;;
    *) return 1 ;;
  esac
}

inspect_html() {
  python3 - "$1" "$EXPECTED_TITLE" "$2" <<'PY'
import re
import sys
from html.parser import HTMLParser


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_title = False
        self.title_parts = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "title":
            self.in_title = True
        if tag.lower() == "script":
            attributes = dict(attrs)
            if attributes.get("src"):
                self.scripts.append(attributes["src"])

    def handle_endtag(self, tag):
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data)


path, expected_title, require_asset = sys.argv[1:]
parser = PageParser()
with open(path, encoding="utf-8") as handle:
    parser.feed(handle.read())

title = "".join(parser.title_parts).strip()
if title != expected_title:
    raise SystemExit(f"unexpected page title: {title!r}")

if require_asset == "yes":
    for source in parser.scripts:
        if re.fullmatch(r"/assets/[A-Za-z0-9._-]+\.js", source):
            print(source)
            break
    else:
        raise SystemExit("no same-origin root-relative JavaScript asset found")
PY
}

fetch_exact() {
  local expected_status=$1
  local url=$2
  local output=$3
  local actual_status

  if ! actual_status=$(curl "${curl_options[@]}" --output "$output" \
    --write-out '%{http_code}' "$url"); then
    return 1
  fi
  test "$actual_status" = "$expected_status"
}

check_release_identity() {
  python3 - "$1" "$EXPECTED_RELEASE_SHA" "$EXPECTED_SNAPSHOT_ID" "$EXPECTED_DATA_HASH" <<'PY'
import json
import sys

path, release_sha, snapshot_id, data_hash = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    value = json.load(handle)

expected = {
    "releaseSha": release_sha,
    "snapshotId": snapshot_id,
    "dataHash": data_hash,
}
actual = {key: value.get(key) for key in expected}
if actual != expected:
    raise SystemExit(f"release identity mismatch: expected {expected!r}, got {actual!r}")
PY
}

check_once() {
  local asset_path
  local asset_url
  local deep_url
  local missing_url
  local missing_status

  if ! fetch_exact 200 "$SMOKE_URL/" "$temp_dir/index.html"; then
    return 1
  fi
  if ! asset_path=$(inspect_html "$temp_dir/index.html" yes); then
    return 1
  fi

  if ! fetch_exact 200 "$SMOKE_URL/release.json" "$temp_dir/release.json"; then
    return 1
  fi
  if ! check_release_identity "$temp_dir/release.json"; then
    return 1
  fi

  asset_url=$(url_for "$asset_path") || return 1
  if ! fetch_exact 200 "$asset_url" /dev/null; then
    return 1
  fi

  deep_url=$(url_for "/${SMOKE_DEEP_PATH#/}") || return 1
  if ! fetch_exact 200 "$deep_url" "$temp_dir/deep.html"; then
    return 1
  fi
  if ! inspect_html "$temp_dir/deep.html" no >/dev/null; then
    return 1
  fi

  missing_url=$(url_for "/assets/__deploy_smoke_missing__-${EXPECTED_RELEASE_SHA}.js") || return 1
  fetch_exact 404 "$missing_url" /dev/null
}

attempt=1
while test "$attempt" -le "$SMOKE_ATTEMPTS"; do
  if check_once; then
    printf 'smoke passed: release=%s snapshot=%s dataHash=%s\n' \
      "$EXPECTED_RELEASE_SHA" "$EXPECTED_SNAPSHOT_ID" "$EXPECTED_DATA_HASH"
    exit 0
  fi
  if test "$attempt" -lt "$SMOKE_ATTEMPTS"; then
    printf 'smoke attempt %s/%s failed; retrying\n' "$attempt" "$SMOKE_ATTEMPTS" >&2
    sleep "$SMOKE_RETRY_DELAY"
  fi
  attempt=$((attempt + 1))
done

fail "release $EXPECTED_RELEASE_SHA did not pass after $SMOKE_ATTEMPTS attempt(s)"
exit 1

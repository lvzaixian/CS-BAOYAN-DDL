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
SMOKE_HTML_MAX_BYTES=1048576
SMOKE_RELEASE_MAX_BYTES=16384
SMOKE_SNAPSHOT_MAX_BYTES=16777216
SMOKE_ASSET_MAX_BYTES=8388608
SMOKE_NOT_FOUND_MAX_BYTES=65536

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
  local max_bytes=$4
  local actual_status

  rm -f -- "$output"
  if ! actual_status=$(curl "${curl_options[@]}" --max-filesize "$max_bytes" --output "$output" \
    --write-out '%{http_code}' "$url"); then
    return 1
  fi
  test "$actual_status" = "$expected_status" || return 1
  python3 - "$output" "$max_bytes" <<'PY'
import os
import sys

if os.path.getsize(sys.argv[1]) > int(sys.argv[2]):
    raise SystemExit(1)
PY
}

check_release_identity() {
  python3 - "$1" "$EXPECTED_RELEASE_SHA" "$EXPECTED_SNAPSHOT_ID" "$EXPECTED_DATA_HASH" <<'PY'
import json
import sys

path, release_sha, snapshot_id, data_hash = sys.argv[1:]

def reject_constant(_value):
    raise ValueError("non-standard JSON constant")

def reject_duplicates(pairs):
    value = {}
    for key, child in pairs:
        if key in value:
            raise ValueError("duplicate JSON object key")
        value[key] = child
    return value

with open(path, encoding="utf-8") as handle:
    value = json.load(
        handle,
        object_pairs_hook=reject_duplicates,
        parse_constant=reject_constant,
    )

expected = {
    "releaseSha": release_sha,
    "snapshotId": snapshot_id,
    "dataHash": data_hash,
}
if not isinstance(value, dict) or set(value) != set(expected):
    raise SystemExit("release identity schema mismatch")
if value != expected:
    raise SystemExit("release identity mismatch")
PY
}

check_snapshot_identity() {
  python3 - "$1" "$EXPECTED_SNAPSHOT_ID" "$EXPECTED_DATA_HASH" <<'PY'
import hashlib
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

path, snapshot_id, data_hash = sys.argv[1:]

CANDIDATE_KEYS = {
    "schemaVersion", "scanAt", "defaultFeedId", "feeds", "counts", "opportunities",
}
APPROVAL_KEYS = {"snapshotId", "approvedAt", "previousSnapshotId", "dataHash"}
FEED_KEYS = {"id", "label", "admissionCycle", "eventYear"}
COUNT_KEYS = {
    "confirmedOpen", "confirmedUnknownDeadline", "pendingExcluded", "expired",
}
OPPORTUNITY_KEYS_V1 = {
    "projectId", "feedId", "name", "institute", "project", "eventType", "description",
    "verificationStatus", "deadline", "deadlineOriginal", "deadlineEpochMs", "website",
    "tags", "verifiedAt", "discoverySources", "logistics", "recommendation", "materials",
}
SOURCE_KEYS = {"kind", "label", "url"}
FACT_KEYS = {"status", "summary"}
ARRANGEMENT_KEYS = {"mode", "time", "formatLocation"}
VERIFICATION_STATUSES = {"confirmed-open", "confirmed-unknown-deadline", "expired"}
FACT_STATUSES = {"confirmed", "not-published", "unverified", "not-applicable"}
DISCOVERY_KINDS = {"official", "baoyan-notice", "cs-baoyan", "other-discovery"}
EVENT_MODES = {"online", "offline", "hybrid", "unknown"}
DENIED_OFFICIAL_HOSTS = {
    "ddl.csbaoyan.top", "github.com", "www.baoyantongzhi.com", "baoyantongzhi.com",
}
PRIVATE_KEYS = {
    "submittedprojectids", "welfarescore", "cityplatformvalue", "socialvalue",
    "recommendationtier",
}
ISO_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})"
    r"(?:\.(\d{1,3}))?(?:Z|[+-](\d{2}):(\d{2}))$"
)
REPOSITORY_SNAPSHOT_ID = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-[0-9a-f]{12}$"
)
PRIVATE_PATTERNS = [
    re.compile(r"[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}", re.I),
    re.compile(r"(?:^|[^a-z0-9])(?:(?:\+|%2b)86[ -]?)?1[3-9][0-9][ -]?[0-9]{4}[ -]?[0-9]{4}(?:[^a-z0-9]|$)", re.I),
    re.compile(r"\bfile:/+\S*", re.I),
    re.compile(r"(?:^|[^a-z0-9.])/(?:Users|home)/[a-z0-9_.-]+(?:[\\/]|$)|\b[a-z]:[\\/]+Users[\\/]+[^\\/\s]+|(?:^|[\s\"'(])~[\\/]+", re.I),
    re.compile(r"(?:^|[^a-z0-9_$])(?:submittedProjectIds|welfareScore|cityPlatformValue|socialValue|recommendationTier)(?:[^a-z0-9_$]|$)|targets[\\/]submitted(?:[\\/]|$)|profile_space[\\/]targets(?:[\\/]|$)", re.I),
]


def invalid(message):
    raise ValueError(message)


def reject_constant(_value):
    invalid("snapshot contains a non-standard JSON constant")


def finite_float(value):
    parsed = float(value)
    if not math.isfinite(parsed):
        invalid("snapshot contains a non-finite JSON number")
    return parsed


def reject_duplicates(pairs):
    value = {}
    for key, child in pairs:
        if key in value:
            invalid("snapshot contains a duplicate JSON object key")
        value[key] = child
    return value


def shape(value, required, optional, label):
    if not isinstance(value, dict):
        invalid(f"{label}: expected an object")
    allowed = required | optional
    keys = set(value)
    if not required.issubset(keys) or not keys.issubset(allowed):
        invalid(f"{label}: object schema mismatch")
    return value


def string(value, label, nonempty=False):
    if not isinstance(value, str) or (nonempty and value == ""):
        invalid(f"{label}: expected a string")
    return value


def finite_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        invalid(f"{label}: expected a finite number")
    return value


def integer(value, label, nonnegative=False):
    finite_number(value, label)
    if int(value) != value or (nonnegative and value < 0):
        invalid(f"{label}: expected an integer")
    return int(value)


def parse_timestamp(value, label):
    string(value, label)
    if ISO_TIMESTAMP.fullmatch(value) is None:
        invalid(f"{label}: expected a valid ISO timestamp")
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        invalid(f"{label}: expected a valid ISO timestamp")
    if parsed.utcoffset() is None:
        invalid(f"{label}: expected a timezone offset")
    return parsed


def timestamp_ms(value, label):
    return int(round(parse_timestamp(value, label).timestamp() * 1000))


def canonical_timestamp(value):
    parsed = parse_timestamp(value, "snapshot.approvedAt").astimezone(timezone.utc)
    return parsed.strftime("%Y-%m-%dT%H:%M:%S.") + f"{parsed.microsecond // 1000:03d}Z"


def public_url(value, label):
    string(value, label)
    try:
        parsed = urlsplit(value)
        parsed.port
    except ValueError:
        invalid(f"{label}: expected a parseable HTTP(S) URL")
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.hostname is None:
        invalid(f"{label}: expected a parseable HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        invalid(f"{label}: URL credentials are not allowed")
    return parsed


def denied_official_host(hostname):
    normalized = hostname.lower().rstrip(".")
    return any(
        normalized == denied or normalized.endswith(f".{denied}")
        for denied in DENIED_OFFICIAL_HOSTS
    )


def validate_privacy(root):
    stack = [(root, 0)]
    nodes = 0
    while stack:
        value, depth = stack.pop()
        nodes += 1
        if nodes > 50000 or depth > 256:
            invalid("snapshot privacy scan exceeded its safety budget")
        if isinstance(value, str) or (isinstance(value, (int, float)) and not isinstance(value, bool)):
            current = str(value)
            for _round in range(3):
                if any(pattern.search(current) for pattern in PRIVATE_PATTERNS):
                    invalid("snapshot contains a private publication value")
                decoded = unquote(current)
                if decoded == current:
                    break
                current = decoded
        elif isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in PRIVATE_KEYS:
                    invalid("snapshot contains a private publication key")
                stack.append((child, depth + 1))
        elif isinstance(value, list):
            stack.extend((child, depth + 1) for child in value)


def validate_fact(value, label):
    fact = shape(value, FACT_KEYS, set(), label)
    if fact["status"] not in FACT_STATUSES:
        invalid(f"{label}.status: expected an allowed value")
    string(fact["summary"], f"{label}.summary")


def validate_arrangement(value, label):
    arrangement = shape(value, ARRANGEMENT_KEYS, set(), label)
    if arrangement["mode"] not in EVENT_MODES:
        invalid(f"{label}.mode: expected an allowed value")
    validate_fact(arrangement["time"], f"{label}.time")
    validate_fact(arrangement["formatLocation"], f"{label}.formatLocation")


def validate_source(value, label):
    source = shape(value, SOURCE_KEYS, set(), label)
    if source["kind"] not in DISCOVERY_KINDS:
        invalid(f"{label}.kind: expected an allowed value")
    string(source["label"], f"{label}.label")
    parsed = public_url(source["url"], f"{label}.url")
    if source["kind"] == "official" and denied_official_host(parsed.hostname):
        invalid(f"{label}.url: denied discovery host cannot be official")
    return source["kind"]


def validate_feed(value, index):
    label = f"snapshot.feeds[{index}]"
    feed = shape(value, FEED_KEYS, set(), label)
    feed_id = string(feed["id"], f"{label}.id", True)
    string(feed["label"], f"{label}.label")
    cycle = string(feed["admissionCycle"], f"{label}.admissionCycle")
    if re.fullmatch(r"[0-9]{4}", cycle) is None:
        invalid(f"{label}.admissionCycle: expected four digits")
    integer(feed["eventYear"], f"{label}.eventYear")
    return feed_id, cycle


def validate_opportunity(value, index, schema_version, known_feeds, feed_cycles, now_ms):
    label = f"snapshot.opportunities[{index}]"
    required = OPPORTUNITY_KEYS_V1 | ({"eventArrangement"} if schema_version == 2 else set())
    opportunity = shape(value, required, {"province"}, label)
    project_id = string(opportunity["projectId"], f"{label}.projectId", True)
    feed_id = string(opportunity["feedId"], f"{label}.feedId")
    if feed_id not in known_feeds:
        invalid(f"{label}.feedId: expected a known feed ID")
    for key in ("name", "institute", "project", "eventType", "description"):
        string(opportunity[key], f"{label}.{key}")
    status = opportunity["verificationStatus"]
    if status not in VERIFICATION_STATUSES:
        invalid(f"{label}.verificationStatus: expected an allowed value")
    deadline = opportunity["deadline"]
    if deadline is not None:
        deadline_ms = timestamp_ms(deadline, f"{label}.deadline")
    else:
        deadline_ms = None
    string(opportunity["deadlineOriginal"], f"{label}.deadlineOriginal")
    deadline_epoch = opportunity["deadlineEpochMs"]
    if deadline_epoch is not None:
        deadline_epoch = finite_number(deadline_epoch, f"{label}.deadlineEpochMs")
    parsed_website = public_url(opportunity["website"], f"{label}.website")
    if denied_official_host(parsed_website.hostname):
        invalid(f"{label}.website: denied discovery host cannot be official")
    if not isinstance(opportunity["tags"], list) or not all(
        isinstance(tag, str) for tag in opportunity["tags"]
    ):
        invalid(f"{label}.tags: expected an array of strings")
    if "province" in opportunity:
        string(opportunity["province"], f"{label}.province")
    verified_at_ms = timestamp_ms(opportunity["verifiedAt"], f"{label}.verifiedAt")
    if not isinstance(opportunity["discoverySources"], list):
        invalid(f"{label}.discoverySources: expected an array")
    source_kinds = [
        validate_source(source, f"{label}.discoverySources[{source_index}]")
        for source_index, source in enumerate(opportunity["discoverySources"])
    ]
    if "official" not in source_kinds:
        invalid(f"{label}.discoverySources: expected an official source")
    if schema_version == 2:
        validate_arrangement(opportunity["eventArrangement"], f"{label}.eventArrangement")
    for key in ("logistics", "recommendation", "materials"):
        validate_fact(opportunity[key], f"{label}.{key}")
    if status == "confirmed-open":
        if deadline_ms is None or deadline_epoch is None or deadline_epoch != deadline_ms:
            invalid(f"{label}: confirmed-open deadline fields are invalid")
        if deadline_epoch <= now_ms:
            invalid(f"{label}: confirmed-open deadline must be in the future")
    elif status == "confirmed-unknown-deadline":
        if deadline is not None or deadline_epoch is not None:
            invalid(f"{label}: unknown deadline fields must be null")
    elif deadline is not None or deadline_epoch is not None:
        if deadline_ms is None or deadline_epoch is None or deadline_epoch != deadline_ms:
            invalid(f"{label}: expired deadline fields are invalid")
        if deadline_epoch > now_ms:
            invalid(f"{label}: expired deadline cannot be in the future")
    parts = project_id.split("|")
    if len(parts) != 4 or any(part.strip() == "" for part in parts):
        invalid(f"{label}.projectId: expected four non-empty parts")
    if re.fullmatch(r"[0-9]{4}", parts[0]) is None or parts[0] != feed_cycles[feed_id]:
        invalid(f"{label}.projectId: admission cycle mismatch")
    return {
        "projectId": project_id,
        "status": status,
        "deadlineEpochMs": deadline_epoch,
        "verifiedAtMs": verified_at_ms,
    }


def normalize_numbers(value):
    if isinstance(value, list):
        return [normalize_numbers(child) for child in value]
    if isinstance(value, dict):
        return {key: normalize_numbers(child) for key, child in value.items()}
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


with open(path, encoding="utf-8") as handle:
    value = json.load(
        handle,
        object_pairs_hook=reject_duplicates,
        parse_constant=reject_constant,
        parse_float=finite_float,
    )

try:
    snapshot = shape(value, CANDIDATE_KEYS | APPROVAL_KEYS, set(), "snapshot")
    validate_privacy(snapshot)
    schema_version = snapshot["schemaVersion"]
    if isinstance(schema_version, bool) or schema_version not in {1, 2}:
        invalid("snapshot.schemaVersion: expected exactly 1 or 2")
    scan_at_ms = timestamp_ms(snapshot["scanAt"], "snapshot.scanAt")
    default_feed_id = string(snapshot["defaultFeedId"], "snapshot.defaultFeedId")
    if not isinstance(snapshot["feeds"], list):
        invalid("snapshot.feeds: expected an array")
    known_feeds = set()
    feed_cycles = {}
    for index, feed in enumerate(snapshot["feeds"]):
        feed_id, cycle = validate_feed(feed, index)
        if feed_id in known_feeds:
            invalid(f"snapshot.feeds[{index}].id: duplicate feed ID")
        known_feeds.add(feed_id)
        feed_cycles[feed_id] = cycle
    if default_feed_id not in known_feeds:
        invalid("snapshot.defaultFeedId: expected a known feed ID")
    counts = shape(snapshot["counts"], COUNT_KEYS, set(), "snapshot.counts")
    for key in COUNT_KEYS:
        integer(counts[key], f"snapshot.counts.{key}", True)
    if not isinstance(snapshot["opportunities"], list):
        invalid("snapshot.opportunities: expected an array")
    now_ms = int(time.time() * 1000)
    opportunities = [
        validate_opportunity(row, index, schema_version, known_feeds, feed_cycles, now_ms)
        for index, row in enumerate(snapshot["opportunities"])
    ]
    project_ids = [row["projectId"] for row in opportunities]
    if len(project_ids) != len(set(project_ids)):
        invalid("snapshot.opportunities: duplicate projectId")
    actual_counts = {
        "confirmedOpen": sum(row["status"] == "confirmed-open" for row in opportunities),
        "confirmedUnknownDeadline": sum(
            row["status"] == "confirmed-unknown-deadline" for row in opportunities
        ),
        "expired": sum(row["status"] == "expired" for row in opportunities),
    }
    if any(counts[key] != actual_counts[key] for key in actual_counts):
        invalid("snapshot.counts: opportunity totals do not match")
    previous_deadline = -math.inf
    saw_unknown = False
    saw_expired = False
    for row in opportunities:
        if row["status"] == "expired":
            saw_expired = True
            continue
        if saw_expired:
            invalid("snapshot.opportunities: expired rows must follow active rows")
        if row["status"] == "confirmed-unknown-deadline":
            saw_unknown = True
            continue
        if saw_unknown or row["deadlineEpochMs"] < previous_deadline:
            invalid("snapshot.opportunities: active deadline ordering is invalid")
        previous_deadline = row["deadlineEpochMs"]
    if any(row["verifiedAtMs"] > scan_at_ms for row in opportunities):
        invalid("snapshot.opportunities: verifiedAt must not follow scanAt")
    approved_at = string(snapshot["approvedAt"], "snapshot.approvedAt")
    approved_at_ms = timestamp_ms(approved_at, "snapshot.approvedAt")
    if approved_at_ms < scan_at_ms:
        invalid("snapshot.approvedAt: must not precede scanAt")
    if any(row["verifiedAtMs"] > approved_at_ms for row in opportunities):
        invalid("snapshot.opportunities: verifiedAt must not follow approvedAt")
    previous_snapshot_id = snapshot["previousSnapshotId"]
    if previous_snapshot_id is not None:
        string(previous_snapshot_id, "snapshot.previousSnapshotId")
        previous_match = REPOSITORY_SNAPSHOT_ID.fullmatch(previous_snapshot_id)
        if previous_match is None:
            invalid("snapshot.previousSnapshotId: invalid format")
        parse_timestamp(previous_match.group(1), "snapshot.previousSnapshotId")
    reported_hash = string(snapshot["dataHash"], "snapshot.dataHash")
    if re.fullmatch(r"[0-9a-f]{64}", reported_hash) is None:
        invalid("snapshot.dataHash: invalid format")
    payload = {key: snapshot[key] for key in (
        "schemaVersion", "scanAt", "defaultFeedId", "feeds", "counts", "opportunities",
    )}
    canonical_json = json.dumps(
        normalize_numbers(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    recomputed_hash = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    derived_snapshot_id = f"{canonical_timestamp(approved_at)}-{recomputed_hash[:12]}"
    if reported_hash != recomputed_hash or recomputed_hash != data_hash:
        invalid("snapshot.dataHash: canonical SHA-256 mismatch")
    if snapshot["snapshotId"] != derived_snapshot_id or derived_snapshot_id != snapshot_id:
        invalid("snapshot.snapshotId: derived identity mismatch")
except (KeyError, TypeError, ValueError, OverflowError, RecursionError) as error:
    raise SystemExit(str(error))
PY
}

check_once() {
  local asset_path
  local asset_url
  local deep_url
  local missing_data_url
  local missing_url

  if ! fetch_exact 200 "$SMOKE_URL/" "$temp_dir/index.html" "$SMOKE_HTML_MAX_BYTES"; then
    return 1
  fi
  if ! asset_path=$(inspect_html "$temp_dir/index.html" yes); then
    return 1
  fi

  if ! fetch_exact 200 "$SMOKE_URL/release.json" "$temp_dir/release.json" \
    "$SMOKE_RELEASE_MAX_BYTES"; then
    return 1
  fi
  if ! check_release_identity "$temp_dir/release.json"; then
    return 1
  fi

  if ! fetch_exact 200 "$SMOKE_URL/data/release.json" "$temp_dir/data-release.json" \
    "$SMOKE_RELEASE_MAX_BYTES"; then
    return 1
  fi
  if ! check_release_identity "$temp_dir/data-release.json"; then
    return 1
  fi

  if ! fetch_exact 200 "$SMOKE_URL/data/current.json" "$temp_dir/data-current.json" \
    "$SMOKE_SNAPSHOT_MAX_BYTES"; then
    return 1
  fi
  if ! check_snapshot_identity "$temp_dir/data-current.json"; then
    return 1
  fi

  asset_url=$(url_for "$asset_path") || return 1
  if ! fetch_exact 200 "$asset_url" "$temp_dir/asset.js" "$SMOKE_ASSET_MAX_BYTES"; then
    return 1
  fi

  deep_url=$(url_for "/${SMOKE_DEEP_PATH#/}") || return 1
  if ! fetch_exact 200 "$deep_url" "$temp_dir/deep.html" "$SMOKE_HTML_MAX_BYTES"; then
    return 1
  fi
  if ! inspect_html "$temp_dir/deep.html" no >/dev/null; then
    return 1
  fi

  missing_url=$(url_for "/assets/__deploy_smoke_missing__-${EXPECTED_RELEASE_SHA}.js") || return 1
  if ! fetch_exact 404 "$missing_url" "$temp_dir/missing-asset" \
    "$SMOKE_NOT_FOUND_MAX_BYTES"; then
    return 1
  fi

  missing_data_url=$(url_for "/data/__deploy_smoke_missing__-${EXPECTED_RELEASE_SHA}.json") \
    || return 1
  fetch_exact 404 "$missing_data_url" "$temp_dir/missing-data" "$SMOKE_NOT_FOUND_MAX_BYTES"
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

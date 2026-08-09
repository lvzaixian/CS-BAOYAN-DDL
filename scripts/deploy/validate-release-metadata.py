#!/usr/bin/env python3
"""Validate the non-secret identity binding carried beside a release archive."""

import json
import re
import sys
from datetime import datetime
from pathlib import Path


EXPECTED_KEYS = {"releaseSha", "snapshotId", "dataHash", "archiveSha"}
GIT_SHA = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
SNAPSHOT_ID = re.compile(
    r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-[0-9a-f]{12}"
)


def fail(message: str) -> None:
    raise SystemExit(message)


def validate_snapshot_id(value: object) -> None:
    if not isinstance(value, str):
        fail("release metadata snapshotId is invalid")
    match = SNAPSHOT_ID.fullmatch(value)
    if match is None:
        fail("release metadata snapshotId is invalid")
    try:
        datetime.fromisoformat(match.group(1).replace("Z", "+00:00"))
    except ValueError:
        fail("release metadata snapshotId is invalid")


def validate(metadata_path: Path, expected_release_sha: str) -> dict[str, str]:
    if not GIT_SHA.fullmatch(expected_release_sha):
        fail("expected release SHA is invalid")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        fail("release metadata could not be read as JSON")
    if not isinstance(metadata, dict) or set(metadata) != EXPECTED_KEYS:
        fail("release metadata has an unexpected schema")
    if metadata["releaseSha"] != expected_release_sha:
        fail("release metadata SHA does not match the workflow release")
    if not isinstance(metadata["releaseSha"], str) or not GIT_SHA.fullmatch(metadata["releaseSha"]):
        fail("release metadata SHA is invalid")
    validate_snapshot_id(metadata["snapshotId"])
    for key in ("dataHash", "archiveSha"):
        if not isinstance(metadata[key], str) or not SHA256.fullmatch(metadata[key]):
            fail(f"release metadata {key} is invalid")
    return metadata


def main(argv: list[str]) -> None:
    if len(argv) not in (3, 4):
        fail("usage: validate-release-metadata.py METADATA_PATH EXPECTED_RELEASE_SHA [GITHUB_ENV_PATH]")
    metadata = validate(Path(argv[1]), argv[2])
    if len(argv) == 4:
        with open(argv[3], "a", encoding="utf-8") as environment:
            environment.write(f"EXPECTED_SNAPSHOT_ID={metadata['snapshotId']}\n")
            environment.write(f"EXPECTED_DATA_HASH={metadata['dataHash']}\n")
            environment.write(f"ARCHIVE_SHA={metadata['archiveSha']}\n")


if __name__ == "__main__":
    main(sys.argv)

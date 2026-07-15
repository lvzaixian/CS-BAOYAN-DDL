#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

tracked_staging="$(git ls-files -- 'data/staging/*.json')"
if test -n "$tracked_staging"; then
  printf '%s\n' 'tracked staging JSON is forbidden' >&2
  printf '%s\n' "$tracked_staging" >&2
  exit 1
fi

for forbidden in public/CNAME .github/workflows/update_json.yml; do
  if test -e "$forbidden" || test -L "$forbidden" \
    || git ls-files --error-unmatch -- "$forbidden" >/dev/null 2>&1; then
    printf '%s is forbidden\n' "$forbidden" >&2
    exit 1
  fi
done

private_pattern='submittedProjectIds|targets/submitted|welfareScore|cityPlatformValue|socialValue|recommendationTier|profile_space/targets|(^|[^[:alnum:].:/])/(Users|home)/[[:alnum:]_.-]+|file:/+([^/[:space:]]+/)?(Users|home)/[[:alnum:]_.-]+|[[:alpha:]]:[/\\][Uu]sers[/\\][[:alnum:]_.-]+'
contact_pattern='[[:alnum:]._%+-]+(@|%40)[[:alnum:].-]+\.[[:alpha:]]{2,}|(^|[^[:alnum:]])1[3-9][0-9][ -]?[0-9]{4}[ -]?[0-9]{4}([^[:alnum:]]|$)'

sanitize_reviewed_contacts() {
  sed -E '
    s/(^|[^[:alnum:]._%+-])admissions@pjlab\.org\.cn([^[:alnum:].-]|$)/\1\2/g
    s/(^|[^[:alnum:]._%+-])rbcc@hkust-gz\.edu\.cn([^[:alnum:].-]|$)/\1\2/g
  '
}

scan_git_context() {
  local context="$1"
  local pattern="$2"
  local kind="$3"
  local output
  local status
  local -a grep_command=(git grep)

  if test "$context" = index; then
    grep_command+=(--cached)
  fi

  set +e
  output="$("${grep_command[@]}" -a -n -i -E "$pattern" -- data src public index.html 2>&1)"
  status=$?
  set -e

  if test "$status" -eq 1; then
    return 0
  fi
  if test "$status" -ne 0; then
    printf 'public leak scan failed for %s (git grep exit %s)\n' "$context" "$status" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  if test "$kind" = contact; then
    output="$(printf '%s\n' "$output" | sanitize_reviewed_contacts)"
    if ! printf '%s\n' "$output" | grep -q -E "$contact_pattern"; then
      return 0
    fi
  fi

  printf '%s\n' "$output" >&2
  printf 'private %sdata found in public %s inputs\n' \
    "$(test "$kind" = contact && printf 'contact ' || true)" "$context" >&2
  exit 1
}

for context in worktree index; do
  scan_git_context "$context" "$private_pattern" private
  scan_git_context "$context" "$contact_pattern" contact
done

scan_dist_pattern() {
  local pattern="$1"
  local kind="$2"
  local output
  local status

  set +e
  output="$(grep -R -a -n -i -E "$pattern" dist 2>&1)"
  status=$?
  set -e

  if test "$status" -eq 1; then
    return 0
  fi
  if test "$status" -ne 0; then
    printf 'public leak scan failed for dist (grep exit %s)\n' "$status" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi

  if test "$kind" = contact; then
    output="$(printf '%s\n' "$output" | sanitize_reviewed_contacts)"
    if ! printf '%s\n' "$output" | grep -q -E "$contact_pattern"; then
      return 0
    fi
  fi

  printf '%s\n' "$output" >&2
  printf 'private %sdata found in built dist inputs\n' \
    "$(test "$kind" = contact && printf 'contact ' || true)" >&2
  exit 1
}

# CI runs this gate after the build, so generated source and final artifacts
# are both covered. Only two exact, reviewed public admissions addresses pass.
if test -d dist; then
  scan_dist_pattern "$private_pattern" private
  scan_dist_pattern "$contact_pattern" contact
fi

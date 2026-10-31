#!/usr/bin/env bash
# Sourced by deploy/deploy.sh. Clears the persistent Turbopack build cache when the CSS inputs changed.
#
# WHY (atelier-css-fix, 2026-10-20). The box keeps `.next/cache/turbopack` (12 GB) across deploys, and a
# warm cache kept globals.css's PREVIOUS @import graph: production shipped a stylesheet with zero rules from
# a newly imported app/atelier.css, while an edit to the already-imported current.css arrived. A cold build
# of the same commit was correct. The box has no git checkout, so "did the CSS change?" is answered by a hash
# of the CSS inputs, stored beside the cache after each successful build.
#
# The inputs: every *.css under app/ and components/ (content and the file list, so adding or removing a file
# counts) plus the CSS import lines of both root layouts (app/(app) and app/(auth)). No stored hash (first run, or a failed build) means
# "changed": the next build is cold once, and the hash is written only after a build succeeds.
#
# Owner decision 2026-10-20: clear the cache only when CSS changed, not on every deploy.

AIHR_CSS_HASH_FILE="${AIHR_CSS_HASH_FILE:-.next/cache/aihr-css-inputs.sha256}"
AIHR_TURBOPACK_CACHE_DIR="${AIHR_TURBOPACK_CACHE_DIR:-.next/cache/turbopack}"

aihr_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
}

aihr_css_inputs_hash() {
  {
    find app components -type f -name '*.css' 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s  %s\n' "$(aihr_sha256 < "$f" | cut -d' ' -f1)" "$f"
    done
    grep -hE "^import ['\"][^'\"]+\.css['\"]" 'app/(app)/layout.tsx' 'app/(auth)/layout.tsx' 2>/dev/null || true
  } | aihr_sha256 | cut -d' ' -f1
}

# Before `next build`: clear the cache when a cache exists and the CSS inputs differ from the last good build.
aihr_css_cache_guard() {
  AIHR_CSS_INPUTS_NOW="$(aihr_css_inputs_hash)"
  local before
  before="$(cat "$AIHR_CSS_HASH_FILE" 2>/dev/null || true)"
  if [ -d "$AIHR_TURBOPACK_CACHE_DIR" ] && [ "$before" != "$AIHR_CSS_INPUTS_NOW" ]; then
    echo "▸ CSS inputs changed since the cached build (${before:-no record}) — clearing the Turbopack cache; this build is cold"
    rm -rf "$AIHR_TURBOPACK_CACHE_DIR"
  else
    echo "▸ CSS inputs unchanged — keeping the Turbopack cache"
  fi
}

# After a SUCCESSFUL `next build`: record the inputs this cache now reflects.
aihr_css_cache_record() {
  mkdir -p "$(dirname "$AIHR_CSS_HASH_FILE")"
  printf '%s\n' "${AIHR_CSS_INPUTS_NOW:-$(aihr_css_inputs_hash)}" > "$AIHR_CSS_HASH_FILE"
}

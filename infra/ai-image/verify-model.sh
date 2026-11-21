#!/bin/sh
# Checks a pulled model against its pins (Dockerfile; infra/test/ai-image.test.ts runs it too):
#
#   verify-model.sh <models dir> <manifest digest> <digest>...
#
# 1. The registry's manifest document, which Ollama keeps as <models dir>/blobs/sha256-<hex>, hashes to <manifest
#    digest>: that one value pins the whole model (model-manifest.json is the copy it was taken from).
# 2. That manifest lists exactly <digest>... (its config and every layer), nothing more and nothing less.
# 3. Each of those blobs is on disk and hashes to its own name (Ollama checks them while pulling; this checks again).
#
# It reads the content-addressed blobs only, never Ollama's named manifest files: their layout changed in 0.40.14 (a
# "legacy anchor" copy lists the manifest blob as an extra layer, manifest/manifest.go WriteLegacyAnchor).
set -eu

if [ "$#" -lt 3 ]; then
  echo "usage: verify-model.sh <models dir> <manifest digest> <digest>..." >&2
  exit 2
fi
dir="$1"
manifest="$2"
shift 2

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
blob() {
  printf '%s/blobs/%s' "$dir" "$(printf '%s' "$1" | tr ':' '-')"
}
check() {
  case "$1" in
    sha256:*) ;;
    *) echo "not a sha256 digest: $1" >&2; exit 1 ;;
  esac
  file="$(blob "$1")"
  if [ ! -f "$file" ] || [ -L "$file" ]; then
    echo "missing blob: $1" >&2
    exit 1
  fi
  if [ "sha256:$(sha256 "$file")" != "$1" ]; then
    echo "blob does not match its digest: $1" >&2
    exit 1
  fi
}

check "$manifest"
listed="$(grep -o '"digest" *: *"sha256:[0-9a-f]\{64\}"' "$(blob "$manifest")" | grep -o 'sha256:[0-9a-f]\{64\}' | sort -u | tr '\n' ' ')"
want="$(printf '%s\n' "$@" | sort -u | tr '\n' ' ')"
if [ "$listed" != "$want" ]; then
  echo "the model's manifest lists other files than pinned: $listed" >&2
  exit 1
fi
for d in "$@"; do check "$d"; done
echo "model verified: manifest $manifest and its $# files"

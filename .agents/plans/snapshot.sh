#!/usr/bin/env bash
# Orchestrator snapshot tooling for a non-git repository.
# Source-file manifest excludes generated trees; explicit per-task baselines copy
# only the declared expected-output paths so review diffs stay scoped.
set -euo pipefail
ROOT="/home/bruno/dev/projects/dsh-opencode-go-usage"
SNAP="$ROOT/.agents/plans/snapshots"

_prune() {
  find . \( -path './node_modules' -o -path './lib' -o -path './.agents' -o -path './.git' \) -prune -o "$@"
}

cmd_manifest() { # $1 = output file (absolute)
  cd "$ROOT"
  _prune -type f -print0 | sort -z | xargs -0 sha256sum > "$1"
}

cmd_save() { # $1 = snapshot dir (absolute), rest = paths
  local dir="$1"; shift
  mkdir -p "$dir"
  cd "$ROOT"
  for p in "$@"; do
    if [ -e "$p" ]; then
      mkdir -p "$dir/$(dirname "$p")"
      cp -a "$p" "$dir/$p"
    fi
  done
}

# Print "status<TAB>path" for every source-file change between two manifests.
cmd_changed() { # $1 = before manifest, $2 = after manifest
  python3 - "$1" "$2" <<'PY'
import sys
def load(p):
    d = {}
    for line in open(p):
        line = line.rstrip("\n")
        if not line:
            continue
        h, _, path = line.partition("  ")
        d[path] = h
    return d
before, after = load(sys.argv[1]), load(sys.argv[2])
for path in sorted(set(before) | set(after)):
    b, a = before.get(path), after.get(path)
    if b is None:
        print(f"A\t{path}")
    elif a is None:
        print(f"D\t{path}")
    elif a != b:
        print(f"M\t{path}")
PY
}

# Build a scoped unified diff for review; never touches generated trees.
cmd_diff() { # $1 = task label, $2 = before dir, $3 = output file, rest = paths
  local label="$1" before="$2" out="$3"; shift 3
  cd "$ROOT"
  : > "$out"
  for p in "$@"; do
    case "$p" in */'*'|*/'*'/*) continue ;; esac   # skip glob-ish generated entries
    local b="$before/$p"
    if [ -e "$p" ] && [ ! -e "$b" ]; then
      diff -u --label "/dev/null" --label "$p" /dev/null "$p" >> "$out" || true
    elif [ -e "$p" ] && [ -e "$b" ] && ! diff -q "$b" "$p" >/dev/null; then
      diff -u --label "a/$p" --label "b/$p" "$b" "$p" >> "$out" || true
    elif [ ! -e "$p" ] && [ -e "$b" ]; then
      diff -u --label "a/$p" --label "/dev/null" "$b" /dev/null >> "$out" || true
    fi
  done
  echo "review artifact ($label): $out ($(wc -l < "$out") lines)"
}

"cmd_$1" "${@:2}"

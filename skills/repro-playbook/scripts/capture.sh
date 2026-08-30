#!/usr/bin/env bash
# capture.sh — run a command and record what actually happened.
#
#   capture.sh <out.json> <command> [args...]
#
# Writes JSON: { command, exitCode, stdout, stderr, durationMs, truncated }
#
# This exists so that "it failed" is never a judgement call. The exit code is
# recorded whether or not anyone looks at it, stdout and stderr are kept apart,
# and a stream too large to carry is cut at a stated limit and flagged rather
# than silently shortened.
#
# Never `set -e` around the measured command: a non-zero exit is the most
# interesting outcome we have, not an error to abort on.

set -uo pipefail

LIMIT_BYTES=64000

if [ "$#" -lt 2 ]; then
  echo "usage: capture.sh <out.json> <command> [args...]" >&2
  exit 2
fi

OUT="$1"; shift

if ! command -v python3 >/dev/null 2>&1; then
  echo "capture.sh requires python3 to encode JSON safely; it is not on PATH." >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT_F="$WORK/stdout"; ERR_F="$WORK/stderr"

START_NS="$(python3 -c 'import time;print(time.monotonic_ns())')"
"$@" >"$OUT_F" 2>"$ERR_F"
EXIT_CODE=$?
END_NS="$(python3 -c 'import time;print(time.monotonic_ns())')"

mkdir -p "$(dirname "$OUT")"

CD_OUT="$OUT" \
CD_CMD="$*" \
CD_EXIT="$EXIT_CODE" \
CD_START="$START_NS" \
CD_END="$END_NS" \
CD_LIMIT="$LIMIT_BYTES" \
CD_OUT_F="$OUT_F" \
CD_ERR_F="$ERR_F" \
python3 - <<'PY'
import json, os

limit = int(os.environ["CD_LIMIT"])
truncated = False


def read(path: str) -> str:
    """Read a captured stream, cutting at the limit and saying so if we did."""
    global truncated
    with open(path, "rb") as fh:
        raw = fh.read(limit + 1)
    if len(raw) > limit:
        truncated = True
        raw = raw[:limit]
    # Untrusted output is not guaranteed to be valid UTF-8; never let a stray
    # byte take down the capture that is meant to record it.
    return raw.decode("utf-8", errors="replace")


stdout = read(os.environ["CD_OUT_F"])
stderr = read(os.environ["CD_ERR_F"])

record = {
    "command": os.environ["CD_CMD"],
    "exitCode": int(os.environ["CD_EXIT"]),
    "stdout": stdout,
    "stderr": stderr,
    "durationMs": (int(os.environ["CD_END"]) - int(os.environ["CD_START"])) // 1_000_000,
    "truncated": truncated,
}

with open(os.environ["CD_OUT"], "w", encoding="utf-8") as fh:
    json.dump(record, fh, indent=2)
    fh.write("\n")

print(
    f"captured: exit {record['exitCode']} in {record['durationMs']}ms"
    + (" (output truncated)" if truncated else "")
)
PY

# Exit 0: the capture succeeded. Whether the *measured command* succeeded is in
# the JSON, and conflating the two would throw away the finding.
exit 0

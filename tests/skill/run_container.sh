#!/usr/bin/env bash
# Validate the skill plumbing in a python:3.12-slim container that mimics the Daytona sandbox.
# Usage: tests/skill/run_container.sh [amd64|arm64]   (Daytona is x86_64; on Apple Silicon amd64 is emulated)
set -euo pipefail
ARCH="${1:-amd64}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
docker run --rm --platform "linux/$ARCH" \
  -v "$ROOT/skills/migration-rehearsal:/opt/tfy/skills/migration-rehearsal:ro" \
  -v "$ROOT/tests/skill:/w:ro" \
  python:3.12-slim bash -c '
    pip install -q --root-user-action=ignore "psycopg[binary]" 2>&1 | grep -v notice || true
    pip install -q --root-user-action=ignore pgserver 2>&1 | grep -v notice || echo "(pgserver not installable on this arch)"
    time python /w/e2e_plumbing.py'

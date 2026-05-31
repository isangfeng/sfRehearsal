#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PYTHONDONTWRITEBYTECODE=1
export HF_HOME="${HF_HOME:-$SCRIPT_DIR/.models/huggingface}"
export NLTK_DATA="${NLTK_DATA:-$SCRIPT_DIR/.models/nltk_data}"

if [[ ! -x ".venv/bin/python" ]]; then
  printf "Missing project Python environment. Run: python3 -m venv .venv\n" >&2
  exit 1
fi

exec .venv/bin/python server.py

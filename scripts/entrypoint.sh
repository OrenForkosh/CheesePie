#!/usr/bin/env bash
set -euo pipefail

# If a GIT_REPO is provided, clone/pull into the mounted workdir
if [[ -n "${GIT_REPO:-}" ]]; then
  echo "[entrypoint] Syncing repo $GIT_REPO (branch: ${GIT_BRANCH:-main})"
  if [[ ! -d .git ]]; then
    git init
    git remote add origin "$GIT_REPO" || true
    git fetch --depth=1 origin "${GIT_BRANCH:-main}"
    git checkout -B "${GIT_BRANCH:-main}" "origin/${GIT_BRANCH:-main}"
  else
    git fetch --depth=1 origin "${GIT_BRANCH:-main}"
    git checkout "${GIT_BRANCH:-main}"
    git reset --hard "origin/${GIT_BRANCH:-main}"
  fi
fi

# Install/update dependencies (in case code changed)
if [[ -f requirements.txt ]]; then
  echo "[entrypoint] Installing Python deps"
  pip install -r requirements.txt
fi

echo "[entrypoint] Starting Cheesepie on ${HOST:-0.0.0.0}:${PORT:-8000}"
exec python app.py

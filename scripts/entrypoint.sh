#!/usr/bin/env bash
# Safe installer + runner for Cheesepie
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
MAX_TRIES="${MAX_TRIES:-3}"

PACKAGES=(git ffmpeg)

retry() {
  local n=1
  local max="$1"
  shift
  until "$@"; do
    if (( n >= max )); then
      echo "❌ Command failed after $n attempt(s): $*" >&2
      return 1
    fi
    echo "⚠️  Command failed. Attempt $((n+1))/$max in $((2**n))s: $*" >&2
    sleep $((2**n))
    ((n++))
  done
}

repair_dpkg() {
  echo "🧰 Repairing dpkg/apt state..."
  dpkg --configure -a || true
  apt-get -y -o Dpkg::Options::=--force-confnew install -f || true
}

apt_update() { apt-get update; }
apt_install() { apt-get install -y --no-install-recommends "${PACKAGES[@]}"; }
apt_clean() { apt-get clean && rm -rf /var/lib/apt/lists/*; }

main() {
  retry "$MAX_TRIES" apt_update || repair_dpkg
  if ! apt_install; then
    echo "🔧 Install failed; attempting dpkg repair then retrying..."
    repair_dpkg
    retry "$MAX_TRIES" apt_install
  fi
  apt_clean
  echo "✅ Installed: ${PACKAGES[*]}"

  echo "Installing Python deps"
  pip install -r requirements.txt

  echo "🚀 Running Cheesepie entrypoint..."
  echo " - Starting Cheesepie on ${HOST:-0.0.0.0}:${PORT:-8000}"
  exec python app.py
}

main

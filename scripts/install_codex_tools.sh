#!/usr/bin/env bash
set -euo pipefail

# CheesePie Dev Tools Installer
#
# Installs recommended CLI tools on macOS or Linux:
# - Essentials: ripgrep (rg), fd, jq, httpie, tree, entr, watchexec
# - Python dev: pipx, then uv, ruff, black, mypy, pytest
# - Media: ffmpeg, ImageMagick
#
# Usage:
#   bash scripts/install_tools.sh
#
# Notes:
# - On macOS, requires Homebrew. If missing, the script will prompt you to install it.
# - On Linux, supports apt (Debian/Ubuntu), dnf (Fedora), pacman (Arch). Others: prints guidance.
# - Uses pipx for Python CLIs and adds ~/.local/bin to PATH via `pipx ensurepath`.

log()  { printf "\033[1;34m[INFO]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[DONE]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[WARN]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[FAIL]\033[0m %s\n" "$*"; }

is_command() { command -v "$1" >/dev/null 2>&1; }

# Run a command as root (using sudo if necessary/available)
run_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    if is_command sudo; then
      sudo "$@"
    else
      err "Need root privileges for: $* (install sudo or run as root)"
      return 1
    fi
  else
    "$@"
  fi
}

install_with_brew() {
  local pkgs=(ripgrep fd jq httpie tree entr watchexec ffmpeg imagemagick pipx)
  for pkg in "${pkgs[@]}"; do
    if brew ls --versions "$pkg" >/dev/null 2>&1; then
      log "brew: $pkg already installed"
    else
      log "brew: installing $pkg"
      brew install "$pkg" || { err "brew failed for $pkg"; return 1; }
    fi
  done
}

install_with_apt() {
  # Package name differences
  local pkgs=(ripgrep fd-find jq httpie tree entr ffmpeg imagemagick pipx)
  log "apt: updating package index"
  run_root apt-get update -y || { err "apt-get update failed"; return 1; }
  for pkg in "${pkgs[@]}"; do
    log "apt: installing $pkg"
    if ! run_root apt-get install -y "$pkg"; then
      warn "apt: could not install $pkg (skipping)"
    fi
  done
  # fd on Debian/Ubuntu is 'fdfind'; create a user-local symlink as 'fd' if missing
  if ! is_command fd && is_command fdfind; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"
    ok "Created symlink: ~/.local/bin/fd -> fdfind"
  fi
}

install_with_dnf() {
  # Fedora package names
  local pkgs=(ripgrep fd-find jq httpie tree entr ffmpeg ImageMagick pipx watchexec)
  log "dnf: updating metadata"
  run_root dnf -y makecache || true
  for pkg in "${pkgs[@]}"; do
    log "dnf: installing $pkg"
    if ! run_root dnf install -y "$pkg"; then
      warn "dnf: could not install $pkg (skipping)"
    fi
  done
}

install_with_pacman() {
  local pkgs=(ripgrep fd jq httpie tree entr ffmpeg imagemagick pipx watchexec)
  log "pacman: refreshing"
  run_root pacman -Sy --noconfirm || true
  for pkg in "${pkgs[@]}"; do
    if pacman -Qi "$pkg" >/dev/null 2>&1; then
      log "pacman: $pkg already installed"
    else
      log "pacman: installing $pkg"
      if ! run_root pacman -S --noconfirm "$pkg"; then
        warn "pacman: could not install $pkg (skipping)"
      fi
    fi
  done
}

ensure_pipx() {
  if is_command pipx; then
    return 0
  fi

  # Try package manager-installed pipx first
  if is_command brew && brew ls --versions pipx >/dev/null 2>&1; then
    return 0
  fi
  if is_command apt-get && run_root apt-get install -y pipx; then
    return 0
  fi
  if is_command dnf && run_root dnf install -y pipx; then
    return 0
  fi
  if is_command pacman && run_root pacman -S --noconfirm pipx; then
    return 0
  fi

  # Fallback to pip user install
  if is_command python3; then
    log "Installing pipx via pip --user"
    python3 -m pip install --user -q pipx || { warn "pip install pipx failed"; return 1; }
  else
    warn "python3 not found; cannot install pipx"
    return 1
  fi
}

install_python_clis() {
  if ! is_command pipx; then
    ensure_pipx || warn "pipx unavailable; skipping Python CLI installs"
  fi
  if is_command pipx; then
    # Ensure path for current/future shells
    pipx ensurepath || true
    # Best effort to make pipx-installed binaries available now
    export PATH="$HOME/.local/bin:$PATH"

    local tools=(uv ruff black mypy pytest)
    for tool in "${tools[@]}"; do
      if pipx list 2>/dev/null | grep -E "^package $tool " >/dev/null 2>&1; then
        log "pipx: $tool already installed"
      else
        log "pipx: installing $tool"
        if ! pipx install "$tool"; then
          warn "pipx: failed to install $tool (skipping)"
        fi
      fi
    done
  fi
}

verify_commands() {
  local cmds=(rg jq http tree entr ffmpeg magick convert pipx uv ruff black mypy pytest)
  local missing=()
  for c in "${cmds[@]}"; do
    if is_command "$c"; then
      log "found: $c ($(command -v "$c"))"
    else
      missing+=("$c")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    warn "Missing commands: ${missing[*]} (some may be optional on your distro)"
  else
    ok "All target commands available"
  fi
}

main() {
  case "${OSTYPE:-$(uname -s)}" in
    darwin*|Darwin)
      log "Detected macOS"
      if ! is_command brew; then
        err "Homebrew not found. Install it with: /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        exit 1
      fi
      install_with_brew
      ;;
    linux*|Linux)
      log "Detected Linux"
      if is_command apt-get; then
        install_with_apt
      elif is_command dnf; then
        install_with_dnf
      elif is_command pacman; then
        install_with_pacman
      elif is_command brew; then
        warn "Using Linuxbrew for installs"
        install_with_brew
      else
        err "Unsupported Linux distribution (need apt, dnf, pacman, or brew)"
        exit 1
      fi
      ;;
    *)
      err "Unsupported OS: ${OSTYPE:-$(uname -s)}"
      exit 1
      ;;
  esac

  install_python_clis
  verify_commands

  echo
  ok "Setup complete. You may need to restart your shell for PATH changes (pipx) to take effect."
}

main "$@"


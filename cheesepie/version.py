from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional


def _run_git(repo_root: Path, args: list[str]) -> Optional[str]:
    if shutil.which('git') is None:
        return None
    try:
        res = subprocess.run(
            ['git', '-C', str(repo_root), *args],
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    if res.returncode != 0:
        return None
    out = (res.stdout or '').strip()
    return out or None


def _git_dirty(repo_root: Path) -> bool:
    out = _run_git(repo_root, ['status', '--porcelain'])
    return bool(out and out.strip())


def get_app_version(repo_root: Path | None = None) -> Optional[str]:
    override = os.getenv('CHEESEPIE_VERSION')
    if override:
        override = override.strip()
        if override:
            return override
    if repo_root is None:
        repo_root = Path(__file__).resolve().parent.parent
    if not repo_root.joinpath('.git').exists():
        return None
    tag = _run_git(repo_root, ['describe', '--tags', '--abbrev=0'])
    sha = _run_git(repo_root, ['rev-parse', '--short=8', 'HEAD'])
    if not tag and not sha:
        return None
    if tag and sha:
        version = f'{tag} ({sha})'
    elif sha:
        version = sha
    else:
        version = tag
    if _git_dirty(repo_root):
        version = f'{version} dirty'
    return version


__all__ = ['get_app_version']

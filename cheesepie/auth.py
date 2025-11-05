from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

from flask import Blueprint, current_app, redirect, render_template, request, url_for, make_response
from werkzeug.security import check_password_hash, generate_password_hash


bp = Blueprint("auth", __name__, url_prefix="/auth")


AUTH_FILE = ".cheesepie_auth.json"
COOKIE_NAME = "cp_auth"
SESSION_MINUTES = 30


def _auth_path() -> Path:
    base_dir = Path(__file__).resolve().parent.parent
    env = os.getenv("CHEESEPIE_AUTH_FILE")
    return Path(env).expanduser() if env else base_dir / AUTH_FILE


def _read_auth() -> Dict[str, Any]:
    p = _auth_path()
    try:
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _write_auth(data: Dict[str, Any]) -> None:
    p = _auth_path()
    try:
        existing: Dict[str, Any] = {}
        if p.exists():
            try:
                existing = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                existing = {}
        existing.update(data)
        p.write_text(json.dumps(existing, indent=2, sort_keys=True), encoding="utf-8")
    except Exception:
        current_app.logger.exception("Failed to write auth file")


def get_or_create_secret_key() -> str:
    data = _read_auth()
    key = data.get("secret_key")
    if isinstance(key, str) and key:
        return key
    # generate
    key = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")
    _write_auth({"secret_key": key})
    return key


def password_is_set() -> bool:
    ph = _read_auth().get("password_hash")
    return isinstance(ph, str) and len(ph) > 0


def set_password(plain: str) -> None:
    _write_auth({"password_hash": generate_password_hash(plain)})


def verify_password(plain: str) -> bool:
    ph = _read_auth().get("password_hash")
    if not isinstance(ph, str) or not ph:
        return False
    try:
        return check_password_hash(ph, plain)
    except Exception:
        return False


def _sign(msg: bytes, key: str) -> str:
    sig = hmac.new(key.encode("utf-8"), msg, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")


def create_token(exp_ts: int) -> str:
    payload = json.dumps({"exp": exp_ts}, separators=(",", ":")).encode("utf-8")
    b64 = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    sig = _sign(b64.encode("ascii"), get_or_create_secret_key())
    return f"{b64}.{sig}"


def verify_token(tok: str) -> Tuple[bool, Optional[int]]:
    try:
        b64, sig = tok.split(".", 1)
        expected = _sign(b64.encode("ascii"), get_or_create_secret_key())
        if not hmac.compare_digest(expected, sig):
            return False, None
        padded = b64 + "=" * (-len(b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        exp = int(payload.get("exp", 0))
        if exp <= int(time.time()):
            return False, exp
        return True, exp
    except Exception:
        return False, None


def set_auth_cookie(resp, minutes: int = SESSION_MINUTES) -> None:
    exp = int(time.time()) + minutes * 60
    tok = create_token(exp)
    resp.set_cookie(
        COOKIE_NAME,
        tok,
        max_age=minutes * 60,
        samesite="Lax",
        secure=False,
        httponly=True,
        path="/",
    )


def clear_auth_cookie(resp) -> None:
    try:
        resp.delete_cookie(COOKIE_NAME, path="/")
    except Exception:
        pass


@bp.route("/login", methods=["GET", "POST"])
def login():
    if not password_is_set():
        return redirect(url_for("auth.setup"))
    error = None
    if request.method == "POST":
        if verify_password(request.form.get("password", "")):
            nxt = _get_next_path()
            resp = make_response(redirect(nxt or url_for("pages.home")))
            set_auth_cookie(resp)
            return resp
        error = "Invalid password"
    return render_template("login.html", error=error)


@bp.route("/setup", methods=["GET", "POST"])
def setup():
    if password_is_set():
        return redirect(url_for("auth.login"))
    error = None
    if request.method == "POST":
        pw = request.form.get("password", "")
        cf = request.form.get("confirm", "")
        if not pw:
            error = "Password is required"
        elif pw != cf:
            error = "Passwords do not match"
        else:
            set_password(pw)
            nxt = _get_next_path()
            resp = make_response(redirect(nxt or url_for("pages.home")))
            set_auth_cookie(resp)
            return resp
    return render_template("setup.html", error=error)


@bp.route("/logout")
def logout():
    resp = make_response(redirect(url_for("auth.login")))
    clear_auth_cookie(resp)
    return resp


__all__ = [
    "bp",
    "get_or_create_secret_key",
    "password_is_set",
    "verify_token",
    "set_auth_cookie",
]


# Internal helpers
def _get_next_path() -> Optional[str]:
    """Return a safe in-app path to redirect to after auth.

    Prefers `request.form['next']` then `request.args['next']` and ensures the
    value is a relative path within this app (no external redirects).
    """
    raw = (request.form.get("next") or request.args.get("next") or "").strip()
    if not raw:
        return None
    # Only allow same-app relative paths like "/preproc" or "/api/..."
    parsed = urlparse(raw)
    if parsed.scheme or parsed.netloc:
        return None
    # Disallow protocol-relative ("//example.com") or weird paths
    if raw.startswith("//"):
        return None
    # Ensure it starts with a single '/'
    if not raw.startswith("/"):
        return None
    return raw

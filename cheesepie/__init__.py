from __future__ import annotations

from pathlib import Path
from flask import Flask, redirect, request, url_for


def create_app() -> Flask:
    """Application factory to create and configure the Flask app.
    Current repo uses a flat runner (`python app.py`), so this factory is
    optional; `app.py` can import and reuse pieces from here.
    """
    # Ensure Flask looks for templates/static at the project root
    base_dir = Path(__file__).resolve().parent.parent
    app = Flask(
        __name__,
        template_folder=str(base_dir / 'templates'),
        static_folder=str(base_dir / 'static'),
    )
    # Secret key is only used for Flask, but our auth uses its own HMAC key
    try:
        from .auth import get_or_create_secret_key
        app.secret_key = get_or_create_secret_key()
    except Exception:
        pass

    # Deferred imports to avoid circulars
    from .config import inject_public_config
    from .preproc import bp as preproc_bp
    from .browser import bp as browser_bp
    from .media import bp as media_bp
    from .importer import bp as importer_bp
    from .pages import bp as pages_bp
    from .filters import register_filters
    from .auth import bp as auth_bp, verify_token, password_is_set, set_auth_cookie

    # Context processors
    app.context_processor(inject_public_config)
    register_filters(app)

    # Blueprints
    app.register_blueprint(preproc_bp, url_prefix='/api/preproc')
    app.register_blueprint(browser_bp, url_prefix='/api')
    app.register_blueprint(media_bp)
    app.register_blueprint(importer_bp, url_prefix='/api/import')
    app.register_blueprint(pages_bp)
    app.register_blueprint(auth_bp)

    # Module-specific initialization (MATLAB removed)

    # Auth gate: require valid token for all non-auth, non-static endpoints
    @app.before_request
    def _auth_gate():
        if request.endpoint in (None, 'static'):
            return None
        if request.blueprint == 'auth' or (request.endpoint or '').startswith('auth.'):
            return None
        # First run: no password set → go to setup
        try:
            if not password_is_set():
                return redirect(url_for('auth.setup'))
        except Exception:
            pass
        tok = request.cookies.get('cp_auth')
        ok, _ = (False, None)
        if tok:
            try:
                ok, _ = verify_token(tok)
            except Exception:
                ok = False
        if not ok:
            return redirect(url_for('auth.login', next=request.path))
        return None

    # Sliding session: refresh cookie on activity
    @app.after_request
    def _slide(resp):
        try:
            # Refresh only for non-auth, non-static requests when token is valid
            if request.endpoint not in (None, 'static') and not (request.blueprint == 'auth' or (request.endpoint or '').startswith('auth.')):
                tok = request.cookies.get('cp_auth')
                ok, _ = verify_token(tok or '')
                if ok:
                    from .auth import set_auth_cookie as _set
                    _set(resp)
        except Exception:
            pass
        return resp

    return app

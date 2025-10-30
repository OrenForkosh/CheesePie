from __future__ import annotations

from pathlib import Path
from flask import Flask


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

    # Deferred imports to avoid circulars
    from .config import inject_public_config
    from .matlab import bp as matlab_bp, init_app as matlab_init
    from .preproc import bp as preproc_bp
    from .browser import bp as browser_bp
    from .media import bp as media_bp
    from .importer import bp as importer_bp
    from .pages import bp as pages_bp
    from .filters import register_filters

    # Context processors
    app.context_processor(inject_public_config)
    register_filters(app)

    # Blueprints
    app.register_blueprint(matlab_bp, url_prefix='/api/matlab')
    app.register_blueprint(preproc_bp, url_prefix='/api/preproc')
    app.register_blueprint(browser_bp, url_prefix='/api')
    app.register_blueprint(media_bp)
    app.register_blueprint(importer_bp, url_prefix='/api/import')
    app.register_blueprint(pages_bp)

    # Module-specific initialization
    matlab_init(app)

    return app

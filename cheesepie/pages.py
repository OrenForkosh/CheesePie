from __future__ import annotations

from flask import Blueprint, render_template, request

from .config import (
    cfg_default_animals,
    cfg_default_fps,
    cfg_default_types,
    cfg_keyboard,
    cfg_importer_facilities,
)


bp = Blueprint('pages', __name__)


@bp.route('/')
def home():
    return render_template('browser.html', active_tab='browser')


@bp.route('/browser')
def browser():
    return render_template('browser.html', active_tab='browser')


@bp.route('/preproc')
def preproc():
    video = request.args.get('video')
    return render_template('preproc.html', active_tab='preproc', video=video)


@bp.route('/annotator')
def annotator():
    video = request.args.get('video')
    return render_template(
        'annotator.html',
        active_tab='annotator',
        video=video,
        default_mice=cfg_default_animals(),
        default_fps=cfg_default_fps(),
        default_types=cfg_default_types(),
        keyboard=cfg_keyboard(),
    )

@bp.route('/analyze')
def analyze():
    video = request.args.get('video')
    return render_template('analyze.html', active_tab='analyze', video=video)


@bp.route('/importer')
def importer():
    facilities = cfg_importer_facilities()
    return render_template('importer.html', active_tab='importer', facilities=facilities)


@bp.route('/settings')
def settings():
    return render_template('settings.html', active_tab='settings')


__all__ = ['bp']

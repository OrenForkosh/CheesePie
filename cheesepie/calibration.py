from __future__ import annotations

import concurrent.futures
import io
import logging
import socket
import time
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, send_file

bp = Blueprint('calibration_api', __name__)
_log = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Demo / test-pattern source
# ---------------------------------------------------------------------------

_DEMO_IP = '__demo__'

_DEMO_PROFILES = [
    {'token': 'demo_hd', 'name': 'Demo HD',  'width': 1280, 'height': 720, 'encoding': 'DEMO'},
    {'token': 'demo_sd', 'name': 'Demo SD',  'width': 640,  'height': 480, 'encoding': 'DEMO'},
]


def _demo_frame(profile_token: str = 'demo_hd', frame_idx: int = 0) -> bytes:
    """Generate a synthetic JPEG test-pattern frame using Pillow."""
    from PIL import Image, ImageDraw

    w, h = (1280, 720) if profile_token == 'demo_hd' else (640, 480)
    img  = Image.new('RGB', (w, h), 0)
    draw = ImageDraw.Draw(img)

    # ── Top 2/3: classic colour bars ──────────────────────────────────────
    bar_colours = [
        (255, 255, 255), (255, 255,   0), (  0, 255, 255), (  0, 255,   0),
        (255,   0, 255), (255,   0,   0), (  0,   0, 255), (  0,   0,   0),
    ]
    bar_h  = h * 2 // 3
    bar_w  = w // len(bar_colours)
    for i, c in enumerate(bar_colours):
        draw.rectangle([i * bar_w, 0, (i + 1) * bar_w - 1, bar_h], fill=c)

    # ── Bottom 1/3: horizontal luminance ramp ─────────────────────────────
    for x in range(w):
        v = int(x / (w - 1) * 255)
        draw.line([(x, bar_h), (x, h - 1)], fill=(v, v, v))

    # ── Animated element: small moving dot so the "stream" looks live ──────
    dot_x  = int((frame_idx * 4) % w)
    dot_y  = h - 20
    radius = 6
    draw.ellipse([dot_x - radius, dot_y - radius,
                  dot_x + radius, dot_y + radius], fill=(255, 200, 0))

    # ── Timestamp overlay ─────────────────────────────────────────────────
    ts = time.strftime('%H:%M:%S')
    draw.text((8, 8), f'DEMO  {ts}  #{frame_idx}', fill=(255, 255, 255))

    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=85)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cfg() -> dict:
    from .config import CONFIG
    raw = CONFIG.get('calibration', {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        'user':         str(raw.get('onvif_user',     'admin')).strip(),
        'password':     str(raw.get('onvif_password', '12345')).strip(),
        'subnet':       str(raw.get('subnet',         '10.0.0')).strip().rstrip('.'),
        'port':         int(raw.get('onvif_port',     80)),
        'mask_path':    str(raw.get('mask_path',
                                    'external/camera_calibration_mask.png')).strip(),
    }


def _make_camera(ip: str):
    """Return an ONVIFCamera; raises on failure."""
    from onvif import ONVIFCamera
    cfg = _cfg()
    cam = ONVIFCamera(ip, cfg['port'], cfg['user'], cfg['password'])
    cam.update_xaddrs()
    return cam


def _tcp_ok(ip: str, port: int, timeout: float = 0.35) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
        return False


def _fetch_snapshot_bytes(ip: str, snap_uri: str) -> bytes:
    """Fetch JPEG bytes from the snapshot URI using digest auth."""
    import requests
    from requests.auth import HTTPDigestAuth
    cfg = _cfg()
    r = requests.get(
        snap_uri,
        auth=HTTPDigestAuth(cfg['user'], cfg['password']),
        timeout=6,
    )
    r.raise_for_status()
    return r.content


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@bp.route('/discover')
def discover():
    """Probe <subnet>.1-254 in parallel and try ONVIF on responding hosts."""
    cfg = _cfg()
    subnet = request.args.get('subnet', '').strip().rstrip('.') or cfg['subnet']
    port   = cfg['port']
    user   = cfg['user']
    password = cfg['password']

    names_cfg = _cfg().get('camera_names', {})
    if not isinstance(names_cfg, dict):
        names_cfg = {}

    def probe(last: int):
        ip = f'{subnet}.{last}'
        if not _tcp_ok(ip, port):
            return None
        user_name = str(names_cfg.get(ip, '')).strip()
        try:
            from onvif import ONVIFCamera
            cam = ONVIFCamera(ip, port, user, password)
            cam.update_xaddrs()
            dev  = cam.create_devicemgmt_service()
            info = dev.GetDeviceInformation()
            mfr   = getattr(info, 'Manufacturer',    '') or ''
            model = getattr(info, 'Model',            '') or ''
            # Try the user-assigned friendly name from ONVIF scopes
            friendly = ''
            try:
                scopes = dev.GetScopes()
                for s in (scopes or []):
                    uri = getattr(s, 'ScopeItem', '') or ''
                    if 'onvif.org/name/' in uri:
                        friendly = uri.split('onvif.org/name/')[-1].strip()
                        break
            except Exception as e:
                _log.debug("calibration: could not read scopes from %s: %s", ip, e)
            # Drop the ONVIF "friendly" name if it's just the model string repeated
            model_str = f'{mfr} {model}'.strip().lower()
            if friendly.lower() in (model.lower(), model_str):
                friendly = ''
            return {
                'ip':           ip,
                'user_name':    user_name,
                'friendly_name': friendly,
                'manufacturer': mfr,
                'model':        model,
                'serial':       getattr(info, 'SerialNumber',    '') or '',
                'firmware':     getattr(info, 'FirmwareVersion', '') or '',
                'onvif_port':   port,
                'onvif':        True,
            }
        except Exception:
            return {
                'ip':           ip,
                'user_name':    user_name,
                'friendly_name': '',
                'manufacturer': '',
                'model':        '',
                'serial':       '',
                'firmware':     '',
                'onvif_port':   port,
                'onvif':        False,
            }

    cameras = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=40) as ex:
        futs = {ex.submit(probe, i): i for i in range(1, 255)}
        for f in concurrent.futures.as_completed(futs, timeout=8):
            try:
                result = f.result()
            except Exception:
                result = None
            if result:
                cameras.append(result)

    cameras.sort(key=lambda c: tuple(int(p) for p in c['ip'].split('.')))
    return jsonify({'cameras': cameras})


@bp.route('/profiles')
def profiles():
    ip = request.args.get('ip', '').strip()
    if not ip:
        return jsonify({'error': 'Missing ip'}), 400
    if ip == _DEMO_IP:
        return jsonify({'profiles': _DEMO_PROFILES})
    try:
        cam   = _make_camera(ip)
        media = cam.create_media_service()
        raw   = media.GetProfiles()
        out   = []
        for p in raw:
            w = h = enc = None
            try:
                vc  = p.VideoEncoderConfiguration
                enc = str(vc.Encoding)
                w   = int(vc.Resolution.Width)
                h   = int(vc.Resolution.Height)
            except Exception:
                pass
            out.append({
                'token':    p.token,
                'name':     p.Name,
                'encoding': enc,
                'width':    w,
                'height':   h,
            })
        return jsonify({'profiles': out})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/snapshot')
def snapshot():
    ip      = request.args.get('ip',      '').strip()
    profile = request.args.get('profile', '').strip()
    if not ip or not profile:
        return jsonify({'error': 'Missing ip or profile'}), 400
    if ip == _DEMO_IP:
        data = _demo_frame(profile)
        return Response(data, mimetype='image/jpeg', headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        })
    try:
        cam   = _make_camera(ip)
        media = cam.create_media_service()
        resp  = media.GetSnapshotUri({'ProfileToken': profile})
        data  = _fetch_snapshot_bytes(ip, resp.Uri)
        return Response(data, mimetype='image/jpeg', headers={
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/stream')
def stream():
    """Proxy an MJPEG stream from the camera over RTSP via OpenCV."""
    ip      = request.args.get('ip',      '').strip()
    profile = request.args.get('profile', '').strip()
    if not ip or not profile:
        return jsonify({'error': 'Missing ip or profile'}), 400

    if ip == _DEMO_IP:
        def _demo_gen():
            idx = 0
            while True:
                jpg = _demo_frame(profile, idx)
                yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + jpg + b'\r\n')
                idx += 1
                time.sleep(0.1)   # ~10 fps
        return Response(_demo_gen(),
                        mimetype='multipart/x-mixed-replace; boundary=frame',
                        headers={'Cache-Control': 'no-cache'})

    cfg = _cfg()
    try:
        cam   = _make_camera(ip)
        media = cam.create_media_service()
        resp  = media.GetStreamUri({
            'StreamSetup': {
                'Stream':    'RTP-Unicast',
                'Transport': {'Protocol': 'RTSP'},
            },
            'ProfileToken': profile,
        })
        rtsp_url = resp.Uri
        # Inject credentials if not already present
        if '://' in rtsp_url and '@' not in rtsp_url.split('://')[1]:
            scheme, rest = rtsp_url.split('://', 1)
            rtsp_url = f'{scheme}://{cfg["user"]}:{cfg["password"]}@{rest}'
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    def _gen():
        import cv2
        cap = cv2.VideoCapture(rtsp_url)
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                _, buf = cv2.imencode('.jpg', frame,
                                      [cv2.IMWRITE_JPEG_QUALITY, 75])
                jpg = buf.tobytes()
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + jpg + b'\r\n')
        finally:
            cap.release()

    return Response(_gen(),
                    mimetype='multipart/x-mixed-replace; boundary=frame',
                    headers={'Cache-Control': 'no-cache'})


@bp.route('/ptz', methods=['POST'])
def ptz():
    payload  = request.json or {}
    ip       = str(payload.get('ip',     '')).strip()
    action   = str(payload.get('action', '')).strip()
    speed    = float(payload.get('speed', 0.5))
    profile  = str(payload.get('profile', '')).strip()

    if not ip or not action:
        return jsonify({'error': 'Missing ip or action'}), 400

    if ip == _DEMO_IP:
        return jsonify({'ok': True, 'note': 'demo_no_op'})

    try:
        cam   = _make_camera(ip)
        media = cam.create_media_service()

        # Resolve profile token
        if profile:
            ptoken = profile
        else:
            profs  = media.GetProfiles()
            ptoken = profs[0].token if profs else ''

        if action == 'stop':
            try:
                ptz_svc = cam.create_ptz_service()
                ptz_svc.Stop({'ProfileToken': ptoken,
                               'PanTilt': True, 'Zoom': True})
            except Exception as e:
                _log.debug("calibration: PTZ stop failed for %s: %s", ip, e)
            # Also stop any imaging move
            try:
                img_svc = cam.create_imaging_service()
                vsrc    = media.GetVideoSources()
                if vsrc:
                    img_svc.Stop({'VideoSourceToken': vsrc[0].token})
            except Exception as e:
                _log.debug("calibration: imaging stop failed for %s: %s", ip, e)
            return jsonify({'ok': True})

        if action in ('zoom_in', 'zoom_out'):
            ptz_svc = cam.create_ptz_service()
            z = speed if action == 'zoom_in' else -speed
            ptz_svc.ContinuousMove({
                'ProfileToken': ptoken,
                'Velocity': {
                    'PanTilt': {'x': 0.0, 'y': 0.0},
                    'Zoom':    {'x': z},
                },
            })
            return jsonify({'ok': True})

        if action in ('focus_near', 'focus_far'):
            spd = speed if action == 'focus_far' else -speed
            try:
                img_svc = cam.create_imaging_service()
                vsrc    = media.GetVideoSources()
                src_tok = vsrc[0].token if vsrc else None
                if src_tok:
                    img_svc.Move({
                        'VideoSourceToken': src_tok,
                        'Focus': {'Continuous': {'Speed': spd}},
                    })
                    return jsonify({'ok': True})
            except Exception:
                pass
            return jsonify({'ok': True, 'note': 'focus_not_available'})

        if action == 'autofocus':
            try:
                img_svc = cam.create_imaging_service()
                vsrc    = media.GetVideoSources()
                src_tok = vsrc[0].token if vsrc else None
                if not src_tok:
                    return jsonify({'ok': True, 'note': 'autofocus_not_available'})
                # Try one-shot autofocus via ImagingSettings
                settings = img_svc.GetImagingSettings({'VideoSourceToken': src_tok})
                try:
                    settings.Focus.AutoFocusMode = 'AUTO'
                    img_svc.SetImagingSettings({
                        'VideoSourceToken': src_tok,
                        'ImagingSettings':  settings,
                        'ForcePersistence': False,
                    })
                    return jsonify({'ok': True})
                except Exception as e:
                    _log.debug("calibration: SetImagingSettings autofocus failed for %s: %s", ip, e)
                # Fallback: trigger a Move with zero speed to nudge autofocus
                try:
                    img_svc.Move({
                        'VideoSourceToken': src_tok,
                        'Focus': {'Continuous': {'Speed': 0.0}},
                    })
                except Exception as e:
                    _log.debug("calibration: imaging Move fallback failed for %s: %s", ip, e)
                return jsonify({'ok': True, 'note': 'autofocus_sent'})
            except Exception as ae:
                return jsonify({'ok': True, 'note': f'autofocus_not_available: {ae}'})

        return jsonify({'error': f'Unknown action: {action}'}), 400

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/config', methods=['GET'])
def get_config():
    cfg = _cfg()
    return jsonify({
        'subnet':     cfg['subnet'],
        'onvif_port': cfg['port'],
        'onvif_user': cfg['user'],
    })


@bp.route('/config', methods=['POST'])
def set_config():
    from .config import CONFIG, _config_path
    import json as _json

    payload = request.json or {}
    cfg_path = _config_path()

    # Load the full config file so we only touch the calibration section
    try:
        full = _json.loads(cfg_path.read_text(encoding='utf-8'))
    except Exception:
        full = dict(CONFIG)

    cal = full.setdefault('calibration', {})

    if 'subnet' in payload:
        subnet = str(payload['subnet']).strip().rstrip('.')
        if subnet:
            cal['subnet'] = subnet

    if 'onvif_port' in payload:
        try:
            cal['onvif_port'] = int(payload['onvif_port'])
        except (ValueError, TypeError):
            return jsonify({'error': 'onvif_port must be an integer'}), 400

    if 'onvif_user' in payload:
        cal['onvif_user'] = str(payload['onvif_user']).strip()

    try:
        cfg_path.write_text(_json.dumps(full, indent=2, ensure_ascii=False), encoding='utf-8')
        # Refresh the in-memory CONFIG so subsequent requests see the new values
        CONFIG['calibration'] = cal
    except Exception as e:
        return jsonify({'error': f'Failed to write config: {e}'}), 500

    return jsonify({'ok': True})


@bp.route('/mask')
def mask():
    cfg       = _cfg()
    mask_path = BASE_DIR / cfg['mask_path']
    if not mask_path.exists():
        return jsonify({'error': f'Mask not found: {mask_path}'}), 404
    return send_file(str(mask_path), mimetype='image/png',
                     max_age=0)



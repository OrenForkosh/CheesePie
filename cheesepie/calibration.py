from __future__ import annotations

import concurrent.futures
import socket
from pathlib import Path

import numpy as np
from flask import Blueprint, Response, jsonify, request, send_file

bp = Blueprint('calibration_api', __name__)

BASE_DIR = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cfg() -> dict:
    from .config import CONFIG
    raw = CONFIG.get('calibration', {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        'user':     str(raw.get('onvif_user',     'admin')).strip(),
        'password': str(raw.get('onvif_password', '12345')).strip(),
        'subnet':   str(raw.get('subnet',         '10.0.0')).strip().rstrip('.'),
        'port':     int(raw.get('onvif_port',     80)),
        'mask_path': str(raw.get('mask_path',
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
    """Probe 10.0.0.1-254 in parallel and try ONVIF on responding hosts."""
    cfg = _cfg()
    subnet = cfg['subnet']
    port   = cfg['port']
    user   = cfg['user']
    password = cfg['password']

    def probe(last: int):
        ip = f'{subnet}.{last}'
        if not _tcp_ok(ip, port):
            return None
        try:
            from onvif import ONVIFCamera
            cam = ONVIFCamera(ip, port, user, password)
            cam.update_xaddrs()
            dev  = cam.create_devicemgmt_service()
            info = dev.GetDeviceInformation()
            mfr   = getattr(info, 'Manufacturer',    '') or ''
            model = getattr(info, 'Model',            '') or ''
            name  = f'{mfr} {model}'.strip() or ip
            return {
                'ip':          ip,
                'name':        name,
                'manufacturer': mfr,
                'model':       model,
                'serial':      getattr(info, 'SerialNumber',    '') or '',
                'firmware':    getattr(info, 'FirmwareVersion', '') or '',
                'onvif_port':  port,
                'onvif':       True,
            }
        except Exception:
            # Port 80 responds but not (or not yet) ONVIF — include anyway
            return {
                'ip':          ip,
                'name':        ip,
                'manufacturer': '',
                'model':       '',
                'serial':      '',
                'firmware':    '',
                'onvif_port':  port,
                'onvif':       False,
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
            except Exception:
                pass
            # Also stop any imaging move
            try:
                img_svc = cam.create_imaging_service()
                vsrc    = media.GetVideoSources()
                if vsrc:
                    img_svc.Stop({'VideoSourceToken': vsrc[0].token})
            except Exception:
                pass
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
                except Exception:
                    pass
                # Fallback: trigger a Move with zero speed to nudge autofocus
                try:
                    img_svc.Move({
                        'VideoSourceToken': src_tok,
                        'Focus': {'Continuous': {'Speed': 0.0}},
                    })
                except Exception:
                    pass
                return jsonify({'ok': True, 'note': 'autofocus_sent'})
            except Exception as ae:
                return jsonify({'ok': True, 'note': f'autofocus_not_available: {ae}'})

        return jsonify({'error': f'Unknown action: {action}'}), 400

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@bp.route('/mask')
def mask():
    cfg       = _cfg()
    mask_path = BASE_DIR / cfg['mask_path']
    if not mask_path.exists():
        return jsonify({'error': f'Mask not found: {mask_path}'}), 404
    return send_file(str(mask_path), mimetype='image/png',
                     max_age=0)

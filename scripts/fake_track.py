#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone


def iso_now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def append_log(path: str, obj: dict):
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")


def main():
    ap = argparse.ArgumentParser(description='Fake tracker that writes NDJSON progress logs.')
    ap.add_argument('--video', required=True, help='Path to video file')
    ap.add_argument('--sleep', type=float, default=0.4, help='Seconds to sleep per phase')
    args = ap.parse_args()

    vid = os.path.abspath(args.video)
    log_path = vid + '.log'
    steps = ['download', 'preprocess', 'train']
    total = len(steps)
    # Start run
    append_log(log_path, { 'ts': iso_now(), 'event': 'RUN_START', 'step': None, 'index': None, 'total': total, 'msg': 'Run started' })
    time.sleep(args.sleep)
    for i, step in enumerate(steps, start=1):
        append_log(log_path, { 'ts': iso_now(), 'event': 'STEP_START', 'step': step, 'index': i, 'total': total, 'msg': f'Starting {step}' })
        time.sleep(args.sleep)
        append_log(log_path, { 'ts': iso_now(), 'event': 'STEP_END', 'step': step, 'index': i, 'total': total, 'msg': f'{step.capitalize()} complete' })
        time.sleep(args.sleep)
    append_log(log_path, { 'ts': iso_now(), 'event': 'RUN_END', 'step': None, 'index': None, 'total': total, 'msg': 'Run finished' })
    return 0


if __name__ == '__main__':
    sys.exit(main())


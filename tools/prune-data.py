#!/usr/bin/env python3
"""List disposable captures/exports past retention; --delete performs the cleanup."""
import argparse
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.runtime import DATA_ROOT, SETTINGS


def candidates(root, raw_days, export_days, max_raw_mb, now=None):
    now = time.time() if now is None else now
    chosen = {}
    raw = []
    for relative, days in [('data/raw', raw_days), ('exports', export_days)]:
        folder = root / relative
        if not folder.exists() or folder.is_symlink():
            continue
        for file in folder.rglob('*'):
            if file.is_symlink() or not file.is_file() or any(parent.is_symlink() for parent in file.parents if root in parent.parents):
                continue
            info = file.stat()
            if relative == 'data/raw':
                raw.append((info.st_mtime, info.st_size, file))
            if now - info.st_mtime > days * 86400:
                chosen[file] = info.st_size
    remaining = sum(size for _, size, file in raw if file not in chosen)
    for _, size, file in sorted(raw):
        if remaining <= max_raw_mb * 1024 * 1024:
            break
        if file not in chosen:
            chosen[file] = size
            remaining -= size
    return chosen


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--raw-days', type=int, default=SETTINGS['rawRetentionDays'])
    ap.add_argument('--export-days', type=int, default=SETTINGS['exportRetentionDays'])
    ap.add_argument('--max-raw-mb', type=int, default=SETTINGS.get('maxRawMB', 1024))
    ap.add_argument('--delete', action='store_true')
    args = ap.parse_args()
    if min(args.raw_days, args.export_days, args.max_raw_mb) < 1:
        ap.error('Retention days and size budget must be positive')
    files = candidates(DATA_ROOT, args.raw_days, args.export_days, args.max_raw_mb)
    for file, size in files.items():
        print(f'{size:>12,} bytes  {file.relative_to(DATA_ROOT)}')
    print(f'{len(files)} files; {sum(files.values()) / 1024**2:.1f} MiB; ' + ('DELETE' if args.delete else 'dry run (use --delete)'))
    if args.delete:
        for file in files:
            if not file.is_symlink():
                file.unlink()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Reconstruct an offline Cargo vendor directory from the archived crate sources.

Run this inside the extracted source ZIP. It does not execute crate build scripts.
Then point Cargo's source replacement at the printed directory. The original
MSYS2 PKGBUILD still selects the exact features/target and performs its recorded
windows-sys update; the vendor set intentionally includes both lock versions.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    output = (args.output or root / 'vendor').resolve()
    output.mkdir(parents=True, exist_ok=True)
    lock = json.loads((root / 'msys2-package-lock.json').read_text(encoding='utf-8'))
    for row in lock['cargo']['crates']:
        archive = root / 'crates' / row['file']
        if hashlib.sha256(archive.read_bytes()).hexdigest() != row['sha256']:
            raise ValueError('Crate checksum mismatch: ' + row['file'])
        base = row['name'] + '-' + row['version']
        files = {}
        with tarfile.open(archive) as tar:
            for member in tar:
                parts = member.name.split('/')
                if parts[0] != base or any(p in ('..', '') for p in parts[1:]) or '\\' in member.name or ':' in member.name:
                    if member.isdir() and member.name.rstrip('/') == base:
                        continue
                    raise ValueError('Unsafe crate member: ' + member.name)
                destination = output.joinpath(*parts)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    if member.size > 64 * 1024 * 1024:
                        raise ValueError('Unexpected oversized crate file')
                    blob = tar.extractfile(member).read()
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(blob)
                    files['/'.join(parts[1:])] = hashlib.sha256(blob).hexdigest()
                else:
                    raise ValueError('Links or special files are not accepted in crate archives')
        (output / base / '.cargo-checksum.json').write_text(json.dumps({'files': files, 'package': row['sha256']}, sort_keys=True), encoding='utf-8')
    print('[source.crates-io]\nreplace-with = "archived-source"\n[source.archived-source]\ndirectory = ' + json.dumps(str(output)))

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Build deterministic portable libmpv DLLs/notices from a fixed package lock.

Requires bsdtar (included in Windows). Never executes downloaded code.
Development executables and optional plugins are excluded from the runtime.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
from desktop_media import ROOT, digest, fetch_all, load_lock, member_bytes, normalized_text, recipe_hash

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / 'desktop_client/target/media-cache')
    parser.add_argument('--output', type=Path, default=ROOT / 'desktop_client/native')
    args = parser.parse_args()
    lock, tag = load_lock()
    packages = {row['id']: row for row in lock['packages']}
    binaries = fetch_all(args.cache_dir, 'packages', packages.values())
    payload = {}
    for row in packages.values():
        if recipe_hash(binaries[row['file']]) != row['pkgbuildSha256']:
            raise ValueError('Binary recipe does not match lock: ' + row['id'])
    for row in lock['runtimeFiles']:
        package = packages[row['package']]
        blob = member_bytes(binaries[package['file']], row['member'])
        if len(blob) != row['bytes'] or hashlib.sha256(blob).hexdigest() != row['sha256']:
            raise ValueError('Runtime member checksum mismatch: ' + row['path'])
        payload[row['path']] = blob
    for row in lock['noticeFiles']:
        blob = normalized_text(ROOT / row['file'])
        if hashlib.sha256(blob).hexdigest() != row['sha256']:
            raise ValueError('Notice changed without lock update: ' + row['file'])
        payload['licenses/' + Path(row['file']).name] = blob
    notice = normalized_text(ROOT / 'desktop_client/licenses/NOTICE.txt')
    if ('/releases/tag/' + tag).encode() not in notice:
        raise ValueError('NOTICE does not point at this exact source release')
    payload['licenses/NOTICE.txt'] = notice
    payload['licenses/msys2-package-lock.json'] = (json.dumps(lock, indent=2, ensure_ascii=False) + '\n').encode()
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / 'libmpv-runtime.tar.gz'
    temporary = archive.with_suffix('.partial')
    records = []
    with temporary.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', compresslevel=9, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.USTAR_FORMAT) as tar:
            for name, blob in sorted(payload.items()):
                if not re.fullmatch(r'[A-Za-z0-9 ._+/-]+', name) or '..' in Path(name).parts:
                    raise ValueError('Unsafe runtime path: ' + name)
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode, entry.mtime = len(blob), 0o644, 0
                tar.addfile(entry, io.BytesIO(blob))
                records.append({'path': name, 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
    temporary.replace(archive)
    manifest = {'schema': 1, 'library': 'libmpv-2.dll', 'archiveSha256': digest(archive),
                'uncompressedBytes': sum(row['bytes'] for row in records), 'files': records}
    (args.output / 'libmpv-runtime.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive), 'bytes': archive.stat().st_size,
                      'sha256': manifest['archiveSha256'], 'files': len(records),
                      'uncompressedBytes': manifest['uncompressedBytes'], 'sourceTag': tag}, indent=2))

if __name__ == '__main__':
    main()

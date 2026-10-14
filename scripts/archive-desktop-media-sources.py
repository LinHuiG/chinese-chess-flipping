#!/usr/bin/env python3
"""Archive verified matching MSYS2 sources and incorporated dependency sources.

The fixed lock is an audited source selection, not a claim inferred solely from
successful compilation. Every fetched object is checked before the receipt is
marked complete. No source/build script is executed. Requires Windows bsdtar.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import zipfile
from desktop_media import ROOT, digest, fetch_all, load_lock, member_bytes, members, normalized_text, recipe_hash

README = '''CyberRoom Windows native media corresponding source

This archive accompanies the exact MSYS2 media component lock in
msys2-package-lock.json. It contains the original source packages (including
PKGBUILD, .SRCINFO, patches, source tarballs or complete bare Git repositories),
the binary package .BUILDINFO/.PKGINFO records, and Cargo dependency sources.
The lock maps every shipped DLL to its package and source version. Packages
marked incorporated-source supply static code, inline code or generated-header
inputs; they do not add unnecessary executables to the runtime.

Build environment and procedure
1. Use MSYS2's MINGW64 environment (x86_64 Windows GNU ABI, not UCRT64 or v3).
2. Extract a sources/*.src.tar.zst into a separate build directory using bsdtar.
   PKGBUILD contains the complete prepare/build/package functions, options,
   patches and order. .SRCINFO lists the original inputs and their checksums.
   build-records/<package>/.BUILDINFO records exact installed build tool and
   dependency versions, architecture, flags, original recipe SHA and build date.
3. Use the matching MINGW64 makepkg-mingw toolchain/dependencies identified by
   those records, then run makepkg-mingw for each required dependency and mpv.
   Do not execute a PKGBUILD until you have reviewed it. Compiler executables,
   operating system libraries and optional tools/plugins are not distributed
   in CyberRoom; the necessary incorporated library source is included here.
4. Rust source packages contain their original Cargo.lock files. Run
   python restore-desktop-media-cargo.py to produce a checksummed vendor tree;
   put its printed source-replacement configuration in the build's Cargo config
   and use offline mode. librsvg's PKGBUILD updates windows-sys 0.61.2 to 0.60.2.
   The original and exact added versions from the retained build log are all
   included; see librsvg-cargo-update.txt and the lock's cargo provenance.
5. CyberRoom packaging/loader sources are in the application repository at
   https://github.com/LinHuiG/chinese-chess-flipping . Run its
   scripts/prepare-desktop-media.py to build the deterministic runtime bundle.
   A changed component requires a reviewed new lock, notices and source release.

The selection is intended to provide the corresponding source of the shipped
libraries, including incorporated dependencies. Reproducing the MSYS2 build
bit-for-bit has not been claimed or tested. Files under sources preserve the
upstream package contents, including any patch instructions and licenses.
GPL-enabled FFmpeg makes this a GPLv3 library distribution, not LGPL-only;
CyberRoom itself is AGPL-3.0-only. See licenses and package-specific notices.
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / 'desktop_client/target/media-cache')
    parser.add_argument('--output', type=Path, default=ROOT / 'server/target/native-media-source-release')
    args = parser.parse_args()
    lock, tag = load_lock()
    args.output.mkdir(parents=True, exist_ok=True)
    # Invalidate a previous receipt before any operation that can fail.
    receipt = args.output / 'source-release.json'
    receipt.write_text(json.dumps({'tag': tag, 'completeCorrespondingSource': False, 'assets': []}) + '\n')
    binaries = fetch_all(args.cache_dir, 'packages', lock['packages'])
    sources = fetch_all(args.cache_dir, 'sources', lock['sources'])
    crates = fetch_all(args.cache_dir, 'crates', lock['cargo']['crates'])
    source_rows = {row['file']: row for row in lock['sources']}
    records = {}
    for row in lock['packages']:
        binary = binaries[row['file']]
        if recipe_hash(binary) != row['pkgbuildSha256'] or row['pkgbuildSha256'] != source_rows[row['sourceFile']]['pkgbuildSha256']:
            raise ValueError('Recipe identity mismatch: ' + row['id'])
        records[row['id']] = {name: member_bytes(binary, name) for name in ('.BUILDINFO', '.PKGINFO')}
    def check_source(row):
        archive = sources[row['file']]
        listing = members(archive)
        recipes = [n for n in listing if n.endswith('/PKGBUILD')]
        if len(recipes) != 1 or hashlib.sha256(member_bytes(archive, recipes[0])).hexdigest() != row['pkgbuildSha256']:
            raise ValueError('Source recipe mismatch: ' + row['file'])
        prefix = recipes[0].rsplit('/', 1)[0] + '/'
        for source in row['inputs']:
            expected = prefix + source['name'] + ('/HEAD' if source['kind'] == 'git' else '')
            if expected not in listing:
                raise ValueError('Source package is missing actual payload: ' + expected)
        return row['file']
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(check_source, lock['sources']))
    archive = args.output / (tag + '-source.zip')
    temporary = archive.with_suffix('.partial')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as output:
        def write_bytes(name, blob):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, blob)
        def write_file(name, path):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            with output.open(info, 'w', force_zip64=True) as target, path.open('rb') as source:
                shutil.copyfileobj(source, target, 1024 * 1024)
        write_bytes('README.txt', README.encode())
        write_bytes('msys2-package-lock.json', (json.dumps(lock, indent=2, ensure_ascii=False) + '\n').encode())
        write_bytes('restore-desktop-media-cargo.py', normalized_text(ROOT / 'scripts/restore-desktop-media-cargo.py'))
        write_bytes('librsvg-cargo-update.txt', normalized_text(ROOT / 'desktop_client/licenses/librsvg-cargo-update.txt'))
        for row in lock['noticeFiles']:
            blob = normalized_text(ROOT / row['file'])
            if hashlib.sha256(blob).hexdigest() != row['sha256']:
                raise ValueError('Notice checksum mismatch')
            write_bytes('licenses/' + Path(row['file']).name, blob)
        write_bytes('licenses/NOTICE.txt', normalized_text(ROOT / 'desktop_client/licenses/NOTICE.txt'))
        for package, values in sorted(records.items()):
            for name, blob in sorted(values.items()):
                write_bytes('build-records/' + package + '/' + name, blob)
        for category, files in [('sources', sources), ('crates', crates)]:
            for name, path in sorted(files.items()):
                write_file(category + '/' + name, path)
    if temporary.stat().st_size >= 2_000_000_000:
        raise ValueError('Source asset exceeds GitHub size limit; split this distribution before publishing')
    with zipfile.ZipFile(temporary) as check:
        failed = check.testzip()
        if failed:
            raise ValueError('Source ZIP CRC failed: ' + failed)
    temporary.replace(archive)
    asset = {'path': archive.name, 'name': archive.name, 'sha256': digest(archive), 'size': archive.stat().st_size}
    metadata = {'tag': tag, 'completeCorrespondingSource': True, 'assets': [asset],
                'sourcePackages': len(sources), 'cargoCrates': len(crates), 'binaryBuildRecords': len(records)}
    receipt.write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(metadata, indent=2))

if __name__ == '__main__':
    main()

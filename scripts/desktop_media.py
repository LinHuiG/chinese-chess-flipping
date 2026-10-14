"""Shared helpers for the pinned MSYS2 media distribution (Python 3.10+)."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'desktop_client/licenses/msys2-package-lock.json'

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def load_lock():
    data = json.loads(LOCK.read_text(encoding='utf-8'))
    if data.get('schema') != 1 or not data.get('sourceAudit', {}).get('complete'):
        raise ValueError('The pinned source audit is incomplete')
    canonical = json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return data, 'media-mpv-msys2-' + hashlib.sha256(canonical).hexdigest()[:12]

def fetch(cache, category, row):
    path = Path(cache) / category / row['file']
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.stat().st_size == row['bytes'] and digest(path) == row['sha256']:
            return path
        raise ValueError('Cached input checksum mismatch: ' + str(path))
    temporary = path.with_suffix(path.suffix + '.download')
    for attempt in range(4):
        try:
            request = urllib.request.Request(row['url'], headers={'User-Agent': 'CyberRoom-source-archive/1'})
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            if temporary.stat().st_size != row['bytes'] or digest(temporary) != row['sha256']:
                raise ValueError('Downloaded input checksum mismatch: ' + row['file'])
            temporary.replace(path)
            return path
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)

def fetch_all(cache, category, rows):
    unique = {row['file']: row for row in rows}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        paths = pool.map(lambda row: fetch(cache, category, row), unique.values())
        return dict(zip(unique, paths))

def member_bytes(path, member):
    if member.startswith(('/', '\\')) or '..' in Path(member).parts or ':' in member or '\\' in member:
        raise ValueError('Unsafe archive member')
    return subprocess.check_output(['tar', '-xOf', str(path), member])

def members(path):
    return subprocess.check_output(['tar', '-tf', str(path)], text=True).splitlines()

def recipe_hash(binary):
    info = member_bytes(binary, '.BUILDINFO').decode('utf-8')
    return next(line.split(' = ', 1)[1] for line in info.splitlines() if line.startswith('pkgbuild_sha256sum = '))

def normalized_text(path):
    return Path(path).read_bytes().replace(b'\r\n', b'\n')

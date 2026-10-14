#!/usr/bin/env python3
"""Publish verified decoder source assets before distributing the Windows binary.

GitHub REST releases/assets API; credentials are read only from GITHUB_TOKEN.
Existing assets are immutable here: a different digest stops publication.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate(receipt):
    data = json.loads(receipt.read_text(encoding='utf-8'))
    if data.get('completeCorrespondingSource') is not True or not re.fullmatch(r'media-mpv-msys2-[a-f0-9]{12}', data.get('tag', '')):
        raise ValueError('Source receipt is incomplete or has an invalid tag')
    assets = data.get('assets', [])
    if not assets or len(assets) > 20:
        raise ValueError('Source receipt has no assets or too many assets')
    names = set()
    for asset in assets:
        name = asset['name']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or name in names:
            raise ValueError('Invalid or duplicate asset name')
        names.add(name)
        path = Path(asset['path'])
        if not path.is_absolute():
            path = receipt.parent / path
        path = path.resolve(strict=True)
        if not path.is_relative_to(receipt.parent.resolve()) or not path.is_file():
            raise ValueError('Source asset is outside the receipt directory')
        if not 0 < asset['size'] < 2_000_000_000 or path.stat().st_size != asset['size'] or digest(path) != asset['sha256']:
            raise ValueError('Source asset digest/size mismatch: ' + name)
        asset['_path'] = path
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt', type=Path)
    parser.add_argument('--check', action='store_true', help='Only validate local assets')
    args = parser.parse_args()
    data = validate(args.receipt.resolve(strict=True))
    if args.check:
        print(f"Verified source release {data['tag']}: {len(data['assets'])} assets")
        return
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    commit = os.environ.get('GITHUB_SHA', '')
    token = os.environ.get('GITHUB_TOKEN', '')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not re.fullmatch(r'[a-f0-9]{40}', commit) or not token:
        raise ValueError('GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN are required')
    root = 'https://api.github.com/repos/' + repository
    opener = urllib.request.build_opener(NoRedirect)

    def request(url, method='GET', body=None, file=None):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.netloc not in ('api.github.com', 'uploads.github.com'):
            raise ValueError('Unexpected GitHub API destination')
        headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CyberRoom-source-publisher'}
        if file:
            headers.update({'Content-Type': 'application/octet-stream', 'Content-Length': str(file.stat().st_size)})
            with file.open('rb') as stream:
                with opener.open(urllib.request.Request(url, data=stream, headers=headers, method=method), timeout=1800) as response:
                    return json.load(response)
        payload = None if body is None else json.dumps(body).encode()
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        with opener.open(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=60) as response:
            return json.load(response)

    try:
        release = request(root + '/releases/tags/' + data['tag'])
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        # The tag endpoint may omit drafts. Recover a partially uploaded draft
        # so a network interruption cannot create duplicate releases.
        release = None
        for page in range(1, 11):
            batch = request(root + f'/releases?per_page=100&page={page}')
            release = next((r for r in batch if r['tag_name'] == data['tag']), None)
            if release or len(batch) < 100:
                break
        if release is None:
            release = request(root + '/releases', 'POST', {
                'tag_name': data['tag'], 'target_commitish': commit, 'draft': True,
                'name': 'Windows 解码组件对应源码 · ' + data['tag'], 'make_latest': 'false',
                'body': '本附件提供赛博房间 Windows 原生播放器所用固定 MSYS2 组件的对应源码、构建配方、依赖清单与许可证。源码包与校验清单配套保存；运行包下载入口见项目 README。',
            })
    upload = release['upload_url'].split('{', 1)[0]
    assets = {a['name']: a for a in release['assets']}
    for asset in data['assets']:
        remote = assets.get(asset['name'])
        if remote is None:
            remote = request(upload + '?' + urllib.parse.urlencode({'name': asset['name']}), 'POST', file=asset['_path'])
        if remote.get('state') != 'uploaded' or remote.get('size') != asset['size'] or remote.get('digest') != 'sha256:' + asset['sha256']:
            raise ValueError('GitHub asset digest/size does not match; no asset was replaced: ' + asset['name'])
        print('Verified uploaded asset: ' + asset['name'])
    if release['draft']:
        release = request(root + '/releases/' + str(release['id']), 'PATCH', {'draft': False, 'make_latest': 'false'})
    if release['draft']:
        raise ValueError('Source release is still a draft')
    print('Published decoder sources: ' + release['html_url'])


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        raise SystemExit(f'GitHub source publication failed: HTTP {error.code}') from None
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from None

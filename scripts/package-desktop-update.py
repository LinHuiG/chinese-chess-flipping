"""Package a built Windows client for the server's optional download endpoint."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "server" / "desktop-update"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Windows package is not a PE executable")
        stream.seek(0)
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Built portable or installer .exe")
    parser.add_argument("--version", help="Optional version; must match desktop_client/tauri.conf.json")
    parser.add_argument("--kind", choices=("portable", "installer"), default="portable")
    parser.add_argument("--check", action="store_true", help="Verify existing package and manifest")
    args = parser.parse_args()
    configured = json.loads((ROOT / "desktop_client/tauri.conf.json").read_text(encoding="utf-8"))["version"]
    if args.version and args.version != configured:
        parser.error("--version must match the configured Windows client version")
    args.version = configured
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", args.version):
        parser.error("--version must be a semantic version")
    exe, manifest = TARGET / "latest.exe", TARGET / "latest.json"
    if args.check:
        meta = json.loads(manifest.read_text(encoding="utf-8"))
        if (meta.get("platform") != "windows" or meta.get("arch") != "x64"
                or meta.get("packageType") not in ("portable", "installer")
                or meta.get("size") != exe.stat().st_size
                or meta.get("sha256") != digest(exe)
                or (args.version and meta.get("versionName") != args.version)):
            raise ValueError("Bundled Windows package manifest/version/hash mismatch")
        print(f"Bundled Windows package verified: {meta['versionName']}, {meta['size']} bytes")
        return
    if not args.source:
        parser.error("packaging requires --source")
    source = args.source.resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".exe":
        parser.error("--source must be a built .exe file")
    checksum = digest(source)
    TARGET.mkdir(parents=True, exist_ok=True)
    # Keep a manifest from being written before its complete executable is ready.
    temporary = TARGET / "latest.exe.tmp"
    try:
        shutil.copyfile(source, temporary)
        temporary.replace(exe)
    finally:
        temporary.unlink(missing_ok=True)
    meta = {
        "productName": "赛博房间",
        "versionName": args.version,
        "platform": "windows",
        "arch": "x64",
        "packageType": args.kind,
        "fileName": f"CyberRoom-{args.version}-windows-x64.exe",
        "size": exe.stat().st_size,
        "sha256": checksum,
        "requiresWebView2": True,
    }
    temporary_manifest = TARGET / "latest.json.tmp"
    try:
        temporary_manifest.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary_manifest.replace(manifest)
    finally:
        temporary_manifest.unlink(missing_ok=True)
    print(f"Packaged Windows {args.version} ({args.kind}), {meta['size']} bytes")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from error

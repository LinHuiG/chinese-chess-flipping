"""Package the built APK and its manifest as runtime image resources (local or Actions)."""
from pathlib import Path
import hashlib, json, re, shutil, sys
root = Path(__file__).resolve().parent.parent
target = root / "server/app-update"
config = (root / "android_client/app/build.gradle.kts").read_text(encoding="utf-8")
version_code = int(re.search(r"versionCode = (\d+)", config)[1])
version_name = re.search(r'versionName = "([^"\n]+)"', config)[1]
if "--check" in sys.argv:
    manifest = json.loads((target / "latest.json").read_text(encoding="utf-8"))
    apk = (target / "latest.apk").read_bytes()
    if (manifest["versionCode"] != version_code or manifest["versionName"] != version_name
            or manifest["packageName"] != "com.chessflipping.client" or manifest["size"] != len(apk)
            or manifest["sha256"] != hashlib.sha256(apk).hexdigest()):
        raise SystemExit("Bundled APK manifest/version/hash mismatch; rebuild and package the APK")
    print(f"Bundled APK verified: {version_name} ({version_code})")
    raise SystemExit(0)
variant = "release" if "--release" in sys.argv else "debug"
source = root / f"android_client/app/build/outputs/apk/{variant}/app-{variant}.apk"
metadata = json.loads((source.parent / "output-metadata.json").read_text(encoding="utf-8"))
entry = metadata["elements"][0]
if metadata["applicationId"] != "com.chessflipping.client":
    raise SystemExit("Unexpected APK application id")
if entry["versionCode"] != version_code or entry["versionName"] != version_name:
    raise SystemExit("Rebuild APK before packaging")
target.mkdir(exist_ok=True)
shutil.copyfile(source, target / "latest.apk")
manifest = {"packageName": metadata["applicationId"], "versionCode": entry["versionCode"],
    "versionName": entry["versionName"], "size": source.stat().st_size,
    "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
(target / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(f"Packaged {manifest['versionName']} ({manifest['versionCode']}), {manifest['size']} bytes")

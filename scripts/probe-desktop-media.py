"""Headless Windows libmpv candidate probe; never replaces installed runtime files.

Example (from repository root):
  python scripts/probe-desktop-media.py --dll-dir server/target/msys-media-review/dlls \
    --media server/target/watch-fixtures/eac3.mkv --output server/target/msys-media-probe

Requires 64-bit Python on Windows. Outputs decoded PNG/PCM and sanitized JSON.
For an authorized remote test, provide its URL only in an environment variable
and use --source-env VARIABLE --label LABEL; the URL is never logged.
"""
import argparse
import array
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import time


class Event(c.Structure):
    _fields_ = [("id", c.c_int), ("error", c.c_int),
                ("reply", c.c_uint64), ("data", c.c_void_p)]


class EndFile(c.Structure):
    _fields_ = [("reason", c.c_int), ("error", c.c_int)]


def bind(lib, name, result, *args):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = result, args
    return fn


def modules(kernel):
    process = bind(kernel, "GetCurrentProcess", c.c_void_p)()
    handles = (c.c_void_p * 1024)()
    needed = c.c_ulong()
    enum = bind(kernel, "K32EnumProcessModules", c.c_int, c.c_void_p,
                c.POINTER(c.c_void_p), c.c_ulong, c.POINTER(c.c_ulong))
    filename = bind(kernel, "K32GetModuleFileNameExW", c.c_ulong,
                    c.c_void_p, c.c_void_p, c.c_wchar_p, c.c_ulong)
    if not enum(process, handles, c.sizeof(handles), c.byref(needed)):
        raise c.WinError()
    if needed.value > c.sizeof(handles):
        raise RuntimeError("Module inventory exceeded its bound")
    result = set()
    for handle in handles[:needed.value // c.sizeof(c.c_void_p)]:
        path = c.create_unicode_buffer(32768)
        if filename(process, handle, path, len(path)):
            result.add(Path(path.value).resolve())
    return result


def pcm_evidence(path):
    if not path.exists():
        return {"frames": 0, "peak": 0}
    raw = path.read_bytes()
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise RuntimeError("PCM output has no WAVE header")
    fmt, pcm = None, b""
    offset = 12
    while offset + 8 <= len(raw):
        kind, size = struct.unpack_from("<4sI", raw, offset)
        block = raw[offset + 8:offset + 8 + size]
        if kind == b"fmt ":
            fmt = block
        elif kind == b"data":
            pcm = block
        offset += 8 + size + (size & 1)
    if not fmt:
        raise RuntimeError("PCM output has no format")
    tag, channels, rate, _, align, bits = struct.unpack_from("<HHIIHH", fmt)
    if tag == 0xfffe and len(fmt) >= 40:
        tag = struct.unpack_from("<H", fmt, 24)[0]
    if tag != 1 or bits != 16:
        raise RuntimeError("PCM output is not signed 16-bit")
    samples = array.array("h", pcm[:len(pcm) & ~1])
    if sys.byteorder != "little":
        samples.byteswap()
    return {"frames": len(pcm) // align, "channels": channels,
            "sampleRate": rate, "bits": bits,
            "nonzeroSamples": sum(sample != 0 for sample in samples),
            "peak": max((abs(sample) for sample in samples), default=0)}


def probe(args, folder):
    if os.name != "nt" or c.sizeof(c.c_void_p) != 8:
        raise RuntimeError("Requires 64-bit Windows Python")
    dll_dir = Path(args.dll_dir).resolve(strict=True)
    library = dll_dir / "libmpv-2.dll"
    source = (os.environ[args.source_env] if args.source_env
              else str(Path(args.media).resolve(strict=True)))
    kernel = c.WinDLL("kernel32", use_last_error=True)
    set_default = bind(kernel, "SetDefaultDllDirectories", c.c_int, c.c_ulong)
    if not set_default(0x800):  # System32; never current directory/PATH.
        raise c.WinError()
    baseline = modules(kernel)
    candidate_names = {p.name.lower() for p in dll_dir.glob("*.dll")}
    if any(p.name.lower() in candidate_names for p in baseline):
        raise RuntimeError("Candidate DLL name already loaded in probe process")
    # LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32.
    lib = c.WinDLL(str(library), winmode=0x900)
    create = bind(lib, "mpv_create", c.c_void_p)
    option = bind(lib, "mpv_set_option_string", c.c_int,
                  c.c_void_p, c.c_char_p, c.c_char_p)
    initialize = bind(lib, "mpv_initialize", c.c_int, c.c_void_p)
    command = bind(lib, "mpv_command", c.c_int, c.c_void_p, c.POINTER(c.c_char_p))
    get_string = bind(lib, "mpv_get_property_string", c.c_void_p, c.c_void_p, c.c_char_p)
    free = bind(lib, "mpv_free", None, c.c_void_p)
    wait = bind(lib, "mpv_wait_event", c.POINTER(Event), c.c_void_p, c.c_double)
    destroy = bind(lib, "mpv_terminate_destroy", None, c.c_void_p)
    ctx = create()
    if not ctx:
        raise RuntimeError("mpv_create returned null")

    def prop(name):
        value = get_string(ctx, name.encode())
        if not value:
            return None
        try:
            return c.string_at(value).decode("utf-8", "replace")
        finally:
            free(value)

    report = {"label": args.label or Path(args.media).name,
              "dllSha256": hashlib.sha256(library.read_bytes()).hexdigest(),
              "loadPolicy": "DLL_LOAD_DIR|SYSTEM32", "loaded": True,
              "durationLimitSeconds": args.seconds, "networkSource": bool(args.source_env)}
    try:
        options = {
            "config": "no", "load-scripts": "no", "terminal": "no",
            "msg-level": "all=no", "input-default-bindings": "no",
            "osc": "no", "hwdec": "no", "vo": "image", "ao": "pcm",
            "vo-image-format": "png", "vo-image-outdir": str(folder),
            "ao-pcm-file": str(folder / "audio.wav"), "audio-format": "s16",
            "audio-channels": "stereo", "length": str(args.seconds),
            "sid": "no", "network-timeout": "15", "keep-open": "no",
        }
        for name, value in options.items():
            code = option(ctx, name.encode(), value.encode())
            if code < 0:
                raise RuntimeError(f"Option {name} rejected ({code})")
        code = initialize(ctx)
        report["initializeCode"] = code
        if code < 0:
            return report
        report["mpvVersion"] = prop("mpv-version")
        report["ffmpegVersion"] = prop("ffmpeg-version")
        fields = ["video-codec", "audio-codec-name", "video-params/w",
                  "video-params/h", "audio-params/channel-count", "audio-params/samplerate",
                  "audio-out-params/channel-count", "audio-out-params/samplerate",
                  "video-out-params/w", "video-out-params/h", "time-pos",
                  "estimated-vf-fps", "current-vo", "current-ao"]
        report["properties"] = {}
        code = command(ctx, (c.c_char_p * 3)(b"loadfile", source.encode(), None))
        if code < 0:
            raise RuntimeError(f"loadfile rejected ({code})")
        deadline = time.monotonic() + args.timeout
        report["status"] = "timeout"
        while time.monotonic() < deadline:
            event = wait(ctx, 0.1).contents
            if event.id == 7 and event.data:
                end = c.cast(event.data, c.POINTER(EndFile)).contents
                report["end"] = {"reason": end.reason, "error": end.error}
                report["status"] = "ended" if end.error == 0 else "playback-error"
                break
            for name in fields:
                value = prop(name)
                if value is not None:
                    report["properties"][name] = value
        added = modules(kernel) - baseline
        system = Path(os.environ["SystemRoot"]) / "System32"
        side_by_side = Path(os.environ["SystemRoot"]) / "WinSxS"
        # Windows activation contexts can resolve OS assemblies into WinSxS
        # even with the strict LoadLibraryEx search flags above.
        os_assemblies = [p for p in added if side_by_side in p.parents]
        external = [p.name for p in added if p.parent != dll_dir and p.parent != system
                    and p not in os_assemblies]
        report["newModules"] = sorted(p.name for p in added)
        report["sideBySideSystemModules"] = sorted(p.name for p in os_assemblies)
        report["unexpectedModuleLocations"] = external
    finally:
        destroy(ctx)
    frames = sorted(folder.glob("*.png"))
    report["video"] = {"frames": len(frames), "bytes": sum(p.stat().st_size for p in frames)}
    if frames:
        data = frames[0].read_bytes()
        report["video"].update({"width": struct.unpack_from(">I", data, 16)[0],
                                "height": struct.unpack_from(">I", data, 20)[0],
                                "firstFrameSha256": hashlib.sha256(data).hexdigest()})
    report["audio"] = pcm_evidence(folder / "audio.wav")
    report["ok"] = (report.get("status") == "ended" and
                    report["video"]["frames"] > 0 and report["audio"]["peak"] > 0 and
                    not report.get("unexpectedModuleLocations"))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dll-dir", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--media")
    source.add_argument("--source-env")
    parser.add_argument("--label")
    parser.add_argument("--output", required=True)
    parser.add_argument("--seconds", type=float, default=2)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    if not 0 < args.seconds <= 10 or not 0 < args.timeout <= 60:
        parser.error("Bounded probe needs 0 < seconds <= 10 and 0 < timeout <= 60")
    if args.source_env and not args.label:
        parser.error("--source-env requires a nonsecret --label")
    folder = Path(args.output).resolve() / time.strftime("%Y%m%d-%H%M%S")
    folder.mkdir(parents=True, exist_ok=False)
    try:
        result = probe(args, folder)
    except Exception as error:
        # No raw exception text: third party errors can contain a source URL.
        result = {"ok": False, "errorType": type(error).__name__,
                  "winerror": getattr(error, "winerror", None)}
    (folder / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items()
                      if key != "newModules"}, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())

fn main() {
    println!("cargo:rerun-if-env-changed=CYBER_ROOM_MPV_ARCHIVE");
    println!("cargo:rerun-if-env-changed=CYBER_ROOM_MPV_MANIFEST");
    let archive = std::env::var_os("CYBER_ROOM_MPV_ARCHIVE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("native/libmpv-runtime.tar.gz"));
    let manifest = std::env::var_os("CYBER_ROOM_MPV_MANIFEST")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("native/libmpv-runtime.json"));
    println!("cargo:rerun-if-changed={}", archive.display());
    println!("cargo:rerun-if-changed={}", manifest.display());
    let (archive, manifest) = if archive.is_file() && manifest.is_file() {
        (
            std::fs::canonicalize(archive).unwrap(),
            std::fs::canonicalize(manifest).unwrap(),
        )
    } else {
        assert!(std::env::var("PROFILE").as_deref() != Ok("release"), "Windows release requires native/libmpv-runtime.tar.gz and native/libmpv-runtime.json; run scripts/prepare-desktop-media.py");
        let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let archive = output.join("no-mpv");
        let manifest = output.join("no-mpv.json");
        std::fs::write(&archive, []).unwrap();
        std::fs::write(&manifest, "{}").unwrap();
        (archive, manifest)
    };
    println!("cargo:rustc-env=CYBER_MPV_ARCHIVE={}", archive.display());
    println!("cargo:rustc-env=CYBER_MPV_MANIFEST={}", manifest.display());
    println!("cargo:rerun-if-changed=src/aec.cpp");
    println!("cargo:rerun-if-changed=src/session.cpp");
    println!("cargo:rerun-if-changed=src/media_window.cpp");
    cc::Build::new()
        .cpp(true)
        .file("src/aec.cpp")
        .file("src/session.cpp")
        .file("src/media_window.cpp")
        .flag_if_supported("/std:c++17")
        .compile("cyber_aec");
    for lib in [
        "ole32",
        "uuid",
        "dmoguids",
        "strmiids",
        "msdmo",
        "wmcodecdspuuid",
        "wtsapi32",
        "user32",
    ] {
        println!("cargo:rustc-link-lib={lib}");
    }
    tauri_build::build();
}

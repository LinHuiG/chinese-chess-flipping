fn main() {
    println!("cargo:rerun-if-changed=src/session.cpp");
    cc::Build::new()
        .cpp(true)
        .file("src/session.cpp")
        .compile("cyber_session");
    println!("cargo:rustc-link-lib=wtsapi32");
    println!("cargo:rustc-link-lib=user32");
    tauri_build::build();
}

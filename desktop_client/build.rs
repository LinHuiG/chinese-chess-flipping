fn main() {
    println!("cargo:rerun-if-changed=src/aec.cpp");
    println!("cargo:rerun-if-changed=src/session.cpp");
    cc::Build::new()
        .cpp(true)
        .file("src/aec.cpp")
        .file("src/session.cpp")
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
    ] {
        println!("cargo:rustc-link-lib={lib}");
    }
    tauri_build::build();
}

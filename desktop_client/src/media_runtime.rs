//! Unpack and verify the entire pinned decoder dependency set before loading it.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u32,
    library: String,
    archive_sha256: String,
    uncompressed_bytes: u64,
    files: Vec<File>,
}
#[derive(Deserialize)]
struct File {
    path: String,
    bytes: u64,
    sha256: String,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_path(value: &str) -> bool {
    // Windows path parsing must not introduce aliases, streams or device names.
    let parts: Vec<_> = value.split('/').collect();
    if !(parts.len() == 1 && value.ends_with(".dll") || parts.len() >= 2 && parts[0] == "licenses")
    {
        return false;
    }
    parts.iter().all(|p| {
        !p.is_empty()
            && *p != "."
            && *p != ".."
            && !p.ends_with(['.', ' '])
            && p.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-+ ".contains(&c))
            && !matches!(
                p.split('.').next().unwrap().to_ascii_uppercase().as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
    })
}
impl Manifest {
    fn parse(text: &str) -> Result<Self, String> {
        let m: Self = serde_json::from_str(text).map_err(|_| "播放器运行库清单无效")?;
        let mut names = HashSet::new();
        if m.schema != 1
            || m.library != "libmpv-2.dll"
            || !valid_hash(&m.archive_sha256)
            || m.files.is_empty()
            || m.files.len() > 8192
            || m.uncompressed_bytes > MAX_BYTES
            || !m.files.iter().any(|f| f.path == m.library)
            || m.files.iter().any(|f| {
                !valid_path(&f.path)
                    || f.bytes > MAX_BYTES
                    || !valid_hash(&f.sha256)
                    || !names.insert(f.path.to_ascii_lowercase())
            })
            || m.files.iter().map(|f| f.bytes).sum::<u64>() != m.uncompressed_bytes
        {
            return Err("播放器运行库清单校验失败".into());
        }
        Ok(m)
    }
}
fn matches_file(folder: &Path, file: &File) -> bool {
    let path = folder.join(&file.path);
    if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.len() == file.bytes) {
        return false;
    }
    let Ok(mut input) = fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => return format!("{:x}", hasher.finalize()) == file.sha256,
            Ok(size) => hasher.update(&buffer[..size]),
            Err(_) => return false,
        }
    }
}
fn no_extra_dlls(folder: &Path, m: &Manifest) -> Result<(), String> {
    for entry in fs::read_dir(folder).map_err(|_| "无法读取播放器缓存")? {
        let entry = entry.map_err(|_| "无法读取播放器缓存")?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".dll") && !m.files.iter().any(|f| f.path.to_ascii_lowercase() == name) {
            return Err("播放器缓存中存在未知运行库，请重新安装或清理播放器缓存".into());
        }
    }
    Ok(())
}
pub fn library_path(directory: &Path) -> Result<PathBuf, String> {
    unpack(
        directory,
        include_str!(env!("CYBER_MPV_MANIFEST")),
        include_bytes!(env!("CYBER_MPV_ARCHIVE")),
    )
}
fn unpack(directory: &Path, text: &str, packed: &[u8]) -> Result<PathBuf, String> {
    if packed.is_empty() {
        return Err("本构建未包含原生播放器运行库".into());
    }
    let m = Manifest::parse(text)?;
    let folder = directory.join("native").join(&m.archive_sha256);
    fs::create_dir_all(&folder).map_err(|_| "无法创建播放器缓存")?;
    no_extra_dlls(&folder, &m)?;
    if m.files.iter().all(|f| matches_file(&folder, f)) {
        return Ok(folder.join(&m.library));
    }
    if digest(packed) != m.archive_sha256 {
        return Err("播放器压缩包完整性验证失败".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = folder.with_file_name(format!(
        "{}.{}.{nonce}.tmp",
        m.archive_sha256,
        std::process::id()
    ));
    fs::create_dir(&staging).map_err(|_| "无法创建播放器解压目录")?;
    let result = (|| {
        let mut seen = HashSet::new();
        let mut archive = tar::Archive::new(
            flate2::read::GzDecoder::new(packed).take(MAX_BYTES + 16 * 1024 * 1024),
        );
        for entry in archive.entries().map_err(|_| "播放器运行库解压失败")? {
            let mut entry = entry.map_err(|_| "播放器运行库解压失败")?;
            let name = std::str::from_utf8(&entry.path_bytes())
                .map_err(|_| "播放器文件路径无效")?
                .to_owned();
            let file = m
                .files
                .iter()
                .find(|f| f.path == name)
                .ok_or("播放器压缩包含未知文件")?;
            if !entry.header().entry_type().is_file()
                || !seen.insert(name.clone())
                || entry.size() != file.bytes
            {
                return Err("播放器压缩包内容无效".into());
            }
            let mut bytes = Vec::new();
            entry
                .by_ref()
                .take(file.bytes + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "播放器运行库解压失败")?;
            if bytes.len() as u64 != file.bytes || digest(&bytes) != file.sha256 {
                return Err("播放器运行库完整性验证失败".into());
            }
            let path = staging.join(&file.path);
            fs::create_dir_all(path.parent().unwrap()).map_err(|_| "播放器缓存写入失败")?;
            fs::write(path, bytes).map_err(|_| "播放器缓存写入失败")?;
        }
        if seen.len() != m.files.len() {
            return Err("播放器压缩包缺少文件".into());
        }
        // Install only after every entry is verified. Other processes may have
        // finished first; never replace a valid DLL which may already be loaded.
        for file in &m.files {
            if matches_file(&folder, file) {
                continue;
            }
            let path = folder.join(&file.path);
            fs::create_dir_all(path.parent().unwrap()).map_err(|_| "播放器缓存写入失败")?;
            if path.exists() {
                fs::remove_file(&path).map_err(|_| "播放器缓存已被占用")?;
            }
            if fs::rename(staging.join(&file.path), &path).is_err() && !matches_file(&folder, file)
            {
                return Err("播放器缓存保存失败".into());
            }
        }
        no_extra_dlls(&folder, &m)?;
        Ok(folder.join(&m.library))
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn fixture() -> (String, Vec<u8>) {
        let mut tar = tar::Builder::new(Vec::new());
        let mut files = Vec::new();
        for (name, data) in [
            ("libmpv-2.dll", "player"),
            ("dependency.dll", "decoder"),
            ("licenses/NOTICE.txt", "notice"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, name, data.as_bytes()).unwrap();
            files.push(serde_json::json!({"path":name,"bytes":data.len(),"sha256":digest(data.as_bytes())}));
        }
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&tar.into_inner().unwrap()).unwrap();
        let bytes = gzip.finish().unwrap();
        let manifest = serde_json::json!({"schema":1,"library":"libmpv-2.dll","archiveSha256":digest(&bytes),"uncompressedBytes":19,"files":files});
        (manifest.to_string(), bytes)
    }
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "cyber-media-{}-{}",
                std::process::id(),
                rand_core::OsRng.next_u64()
            )))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    use rand_core::RngCore;
    #[test]
    fn repairs_corrupted_dependency_and_preserves_valid_cache() {
        let tmp = Temp::new();
        let (text, packed) = fixture();
        let dll = unpack(&tmp.0, &text, &packed).unwrap();
        let dependency = dll.with_file_name("dependency.dll");
        fs::write(&dependency, "changed").unwrap();
        unpack(&tmp.0, &text, &packed).unwrap();
        assert_eq!(fs::read(dependency).unwrap(), b"decoder");
        assert_eq!(unpack(&tmp.0, &text, &packed).unwrap(), dll);
    }
    #[test]
    fn rejects_corrupt_archive_and_unknown_dll() {
        let tmp = Temp::new();
        let (text, packed) = fixture();
        let mut damaged = packed.clone();
        damaged[12] ^= 1;
        assert!(unpack(&tmp.0, &text, &damaged).is_err());
        let dll = unpack(&tmp.0, &text, &packed).unwrap();
        fs::write(dll.with_file_name("injected.dll"), "unexpected").unwrap();
        assert!(unpack(&tmp.0, &text, &packed).is_err());
    }
    #[test]
    fn rejects_paths_aliases_and_manifest_mismatches() {
        let (text, packed) = fixture();
        for bad in [
            "../escape.dll",
            "C:/escape.dll",
            "licenses/../../escape",
            "licenses/CON.txt",
            "licenses/x:stream",
            "licenses/x\\y",
            "licenses/x.",
        ] {
            let tmp = Temp::new();
            let mut m: serde_json::Value = serde_json::from_str(&text).unwrap();
            m["files"][1]["path"] = bad.into();
            assert!(unpack(&tmp.0, &m.to_string(), &packed).is_err(), "{bad}");
            assert!(!tmp.0.exists());
        }
        let tmp = Temp::new();
        let mut m: serde_json::Value = serde_json::from_str(&text).unwrap();
        m["files"][1]["path"] = "LIBMPV-2.dll".into();
        assert!(unpack(&tmp.0, &m.to_string(), &packed).is_err());
        m["files"][1]["path"] = "other.dll".into();
        assert!(unpack(&tmp.0, &m.to_string(), &packed).is_err());
        let folder = tmp
            .0
            .join("native")
            .join(m["archiveSha256"].as_str().unwrap());
        assert!(
            !folder.join("libmpv-2.dll").exists(),
            "no partial installation before verification"
        );
    }
}

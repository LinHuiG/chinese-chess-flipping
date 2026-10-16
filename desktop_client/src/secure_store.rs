use std::{
    fs,
    io::{Read, Write},
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    sync::Mutex,
};
use zeroize::Zeroize;

const MAX_BYTES: usize = 256 * 1024;
const READ_ERROR: &str = "插件存档无法读取或解密，请删除后重新保存";
const WRITE_ERROR: &str = "插件存档保存失败，请检查本机存储";

#[repr(C)]
struct Blob {
    size: u32,
    data: *mut u8,
}
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(
        input: *const Blob,
        description: *const u16,
        entropy: *const Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        input: *const Blob,
        description: *mut *mut u16,
        entropy: *const Blob,
        reserved: *mut std::ffi::c_void,
        prompt: *mut std::ffi::c_void,
        flags: u32,
        output: *mut Blob,
    ) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(data: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
}
fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let input = Blob {
        size: bytes.len() as u32,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    // No LOCAL_MACHINE flag: only this Windows account can decrypt the file.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(if encrypt { WRITE_ERROR } else { READ_ERROR }.into());
    }
    let result = unsafe {
        let data = std::slice::from_raw_parts_mut(output.data, output.size as usize);
        let result = data.to_vec();
        data.zeroize();
        LocalFree(output.data.cast());
        result
    };
    Ok(result)
}
fn validate(text: &str) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err("插件存档超过大小限制".into());
    }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| "插件存档格式无效")?;
    if !value.is_object() {
        return Err("插件存档格式无效".into());
    }
    Ok(())
}

pub struct SecureStore {
    path: PathBuf,
    lock: Mutex<()>,
}
impl SecureStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            path: directory,
            lock: Mutex::new(()),
        }
    }
    pub fn file(&self, namespace: &str) -> Result<PathBuf, String> {
        if namespace.is_empty()
            || namespace.len() > 200
            || !namespace
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
        {
            return Err("存储命名空间无效".into());
        }
        // Preserve the encrypted 0.8.4 file; all new namespaces use SHA-256 filenames.
        if namespace == "official.watch" {
            return Ok(self.path.join("watch-save.dpapi"));
        }
        use sha2::Digest;
        Ok(self.path.join(format!(
            "plugin-{:x}.dpapi",
            sha2::Sha256::digest(namespace)
        )))
    }
    pub fn read(&self, namespace: &str) -> Result<Option<String>, String> {
        let _guard = self.lock.lock().map_err(|_| READ_ERROR)?;
        let file = match fs::File::open(self.file(namespace)?) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(READ_ERROR.into()),
        };
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 16_384 + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| READ_ERROR)?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES + 16_384 {
            return Err(READ_ERROR.into());
        }
        let decrypted = protect(&bytes, false)?;
        let text = String::from_utf8(decrypted).map_err(|_| READ_ERROR)?;
        validate(&text).map_err(|_| READ_ERROR)?;
        Ok(Some(text))
    }
    pub fn write(&self, namespace: &str, text: Option<&str>) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| WRITE_ERROR)?;
        let path = self.file(namespace)?;
        let temporary = path.with_extension("pending");
        if text.is_none_or(|text| text.trim() == "null") {
            for path in [&path, &temporary] {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err("插件存档删除失败".into()),
                }
            }
            return Ok(());
        }
        let text = text.unwrap();
        validate(text)?;
        let encrypted = protect(text.as_bytes(), true)?;
        let result = (|| {
            let mut file = fs::File::create(&temporary).map_err(|_| WRITE_ERROR)?;
            file.write_all(&encrypted)
                .and_then(|_| file.sync_all())
                .map_err(|_| WRITE_ERROR)?;
            drop(file);
            let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
                return Err(WRITE_ERROR.into());
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dpapi_store_roundtrip_replace_delete_and_corruption() {
        let directory = std::env::temp_dir().join(format!(
            "cyber-watch-save-{}",
            rand_core::RngCore::next_u64(&mut rand_core::OsRng)
        ));
        fs::create_dir(&directory).unwrap();
        let store = SecureStore::new(directory.clone());
        let data =
            r#"{"version":1,"source":{"token":"test-token-not-a-real-credential"},"position":42}"#;
        assert_eq!(store.read("test").unwrap(), None);
        store.write("test", Some(data)).unwrap();
        assert_eq!(store.read("test").unwrap().as_deref(), Some(data));
        let bytes = fs::read(store.file("test").unwrap()).unwrap();
        assert!(!bytes.windows(12).any(|b| b == b"test-token-n"));
        store
            .write("test", Some(r#"{"version":1,"position":60}"#))
            .unwrap();
        assert!(store.read("test").unwrap().unwrap().contains("60"));
        assert!(store
            .write("test", Some(r#"{"password":"encrypted"}"#))
            .is_ok());
        assert!(store
            .write(
                "test",
                Some(&format!(r#"{{"token":"{}"}}"#, "x".repeat(MAX_BYTES)))
            )
            .is_err());
        fs::write(store.file("test").unwrap(), b"invalid encrypted payload").unwrap();
        assert!(store.read("test").is_err());
        store.write("test", Some("null")).unwrap();
        assert_eq!(store.read("test").unwrap(), None);
        store.write("test", Some(data)).unwrap();
        store.write("test", None).unwrap();
        assert_eq!(store.read("test").unwrap(), None);
        fs::remove_dir(&directory).unwrap();
    }
}

//! App 更新包：资源随镜像发布，启动时读取一次，HTTP 与 TCP 共用元数据和同一份 APK 字节。
use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

// 发布资源与可执行程序分层；启动后共享内存快照，运行中不混用新旧 APK。
static PACKAGE: OnceLock<(Value, Bytes)> = OnceLock::new();

// 启动时核对资源与清单，避免发布时 APK / versionCode / 校验和彼此不匹配。
pub fn init() -> Result<(), String> {
    let root = crate::resource_root().join("app-update");
    let apk =
        Bytes::from(std::fs::read(root.join("latest.apk")).map_err(|e| format!("Read APK: {e}"))?);
    let manifest =
        std::fs::read(root.join("latest.json")).map_err(|e| format!("Read app manifest: {e}"))?;
    let info: Value = serde_json::from_slice(&manifest).map_err(|_| "Invalid app manifest")?;
    let hash = format!("{:x}", Sha256::digest(&apk));
    if info["size"].as_u64() != Some(apk.len() as u64)
        || info["sha256"] != hash
        || info["versionCode"].as_u64().is_none_or(|v| v == 0)
        || info["packageName"] != "com.chessflipping.client"
    {
        return Err("App package does not match manifest".into());
    }
    PACKAGE
        .set((info, apk))
        .map_err(|_| "App manifest already initialized".to_owned())
}
// 客户端只按递增 versionCode 比较；相同版本或客户端更新时均不下载，绝不降级。
pub fn version(current: u64) -> Value {
    let mut info = PACKAGE.get().expect("init app package").0.clone();
    info["type"] = "APP_VERSION".into();
    info["available"] = (current < info["versionCode"].as_u64().unwrap()).into();
    info
}
// TCP/WS 一次只请求一块，最多 32 KiB；携带目标版本防止服务器重启换包后拼出混合文件。
pub fn chunk(request: &Value) -> Result<(Vec<u8>, Bytes), String> {
    let (info, apk) = PACKAGE.get().expect("init app package");
    let version = request["versionCode"]
        .as_u64()
        .ok_or("Missing app version")?;
    let current = request["currentVersion"]
        .as_u64()
        .ok_or("Missing installed version")?;
    let offset = request["offset"].as_u64().ok_or("Missing app offset")?;
    if version != info["versionCode"] || current >= version || offset >= apk.len() as u64 {
        return Err("App version or offset changed; check again".into());
    }
    let offset = offset as usize;
    let end = (offset + 32768).min(apk.len());
    let control = json!({"type":"APP_CHUNK","versionCode":version,"offset":offset,"size":apk.len(),"done":end==apk.len()});
    Ok((
        serde_json::to_vec(&control).unwrap(),
        apk.slice(offset..end),
    ))
}
// HTTP 与原始 TCP 使用相同的整数版本比较，查询参数必填，避免不带版本就重复下载。
fn current(uri: &Uri) -> Result<u64, StatusCode> {
    uri.query()
        .and_then(|q| q.strip_prefix("versionCode="))
        .and_then(|v| v.parse().ok())
        .ok_or(StatusCode::BAD_REQUEST)
}
// 仅接受单个整数查询参数；不额外引入通用表单解析和 JSON 响应依赖。
pub async fn http_version(uri: Uri) -> Response {
    let Ok(current) = current(&uri) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        version(current).to_string(),
    )
        .into_response()
}
// HTTP 一次发送静态 APK 引用；Body 负责背压，不把安装包编码成 JSON/Base64。
pub async fn http_download(uri: Uri) -> Response {
    let Ok(current) = current(&uri) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let (info, apk) = PACKAGE.get().expect("init app package");
    if current >= info["versionCode"].as_u64().unwrap() {
        return StatusCode::NO_CONTENT.into_response();
    }
    Response::builder()
        .header(
            header::CONTENT_TYPE,
            "application/vnd.android.package-archive",
        )
        .header(header::CONTENT_LENGTH, apk.len())
        .header(header::CACHE_CONTROL, "no-store")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=chess-flipping.apk",
        )
        .body(Body::from(apk.clone()))
        .unwrap()
}

// 版本相同/较新时不得下载；旧版本获取的所有块须重组为同一个完整 APK。
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_gate_and_complete_download() {
        init().unwrap();
        let (_, apk) = PACKAGE.get().unwrap();
        let info = version(0);
        let code = info["versionCode"].as_u64().unwrap();
        assert_eq!(info["available"], true);
        assert_eq!(version(code)["available"], false);
        assert_eq!(version(code + 1)["available"], false);
        let mut request = json!({"versionCode":code,"currentVersion":0,"offset":0});
        let mut result = vec![];
        while result.len() < apk.len() {
            request["offset"] = result.len().into();
            let (header, bytes) = chunk(&request).unwrap();
            let header: Value = serde_json::from_slice(&header).unwrap();
            assert!(bytes.len() <= 32768);
            result.extend_from_slice(&bytes);
            assert_eq!(header["done"], result.len() == apk.len());
        }
        assert_eq!(result.as_slice(), apk.as_ref());
        request["currentVersion"] = code.into();
        assert!(chunk(&request).is_err());
        request["currentVersion"] = 0.into();
        request["offset"] = (apk.len() as u64).into();
        assert!(chunk(&request).is_err());
        assert!(current(
            &"/api/app/version?versionCode=7&versionCode=0"
                .parse()
                .unwrap()
        )
        .is_err());
    }
}

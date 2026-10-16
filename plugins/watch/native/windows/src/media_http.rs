use crate::{media_target_allowed, AppState};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;
pub fn media_image_data_url(content_type: &str, bytes: &[u8]) -> Result<String, String> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        mime.as_str(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    ) {
        return Err("片源未返回支持的图片格式".into());
    }
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
}
pub async fn media_request(state: &AppState, value: Value) -> Result<(u16, String, bool), String> {
    let url = reqwest::Url::parse(
        value
            .get("url")
            .and_then(Value::as_str)
            .ok_or("媒体URL无效")?,
    )
    .map_err(|_| "媒体URL无效")?;
    let allowed = state.media_origin.lock().unwrap().clone();
    if !media_target_allowed(allowed.as_ref(), &url) {
        return Err("媒体请求必须使用已配置的片源地址".into());
    }
    let method = value.get("method").and_then(Value::as_str).unwrap_or("GET");
    if !matches!(method, "GET" | "POST" | "DELETE") {
        return Err("媒体请求方式不支持".into());
    }
    let image = value.get("responseType").and_then(Value::as_str) == Some("image");
    if image && method != "GET" {
        return Err("图片请求必须使用 GET".into());
    }
    let mut request = state
        .http
        .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), url)
        .timeout(Duration::from_millis(
            value
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(20000)
                .clamp(1000, if image { 20000 } else { 60000 }),
        ));
    if let Some(headers) = value.get("headers").and_then(Value::as_object) {
        if headers.len() > 16 {
            return Err("媒体请求头过大".into());
        }
        for (k, v) in headers {
            if matches!(
                k.to_ascii_lowercase().as_str(),
                "host" | "connection" | "content-length" | "cookie"
            ) {
                return Err("不允许的请求头".into());
            }
            let v = v.as_str().filter(|v| v.len() <= 8192).ok_or("请求头无效")?;
            request = request.header(k, v);
        }
    }
    if let Some(body) = value.get("body") {
        let body = if let Some(s) = body.as_str() {
            s.to_string()
        } else {
            body.to_string()
        };
        if body.len() > 262144 {
            return Err("媒体请求过大".into());
        }
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "无法连接片源，请检查地址、网络或证书")?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if response.content_length().is_some_and(|n| n > 2097152) {
        return Err("片源响应过大".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "片源响应中断")?;
        if bytes.len() + chunk.len() > 2097152 {
            return Err("片源响应过大".into());
        }
        bytes.extend(chunk);
    }
    let body = if image {
        if (200..300).contains(&status) {
            media_image_data_url(&content_type, &bytes)?
        } else {
            String::new()
        }
    } else {
        String::from_utf8(bytes).map_err(|_| "片源应返回文本信息".to_string())?
    };
    Ok((status, body, image))
}

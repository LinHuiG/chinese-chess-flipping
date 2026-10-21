use crate::{media_target_allowed, AppState};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;
fn request_error(error: &reqwest::Error, reading: bool) -> &'static str {
    // reqwest's Display includes the request URL, which can contain api_key.
    // Report only the phase and category across the component boundary.
    if error.is_timeout() {
        if reading {
            "Emby 响应读取超时，片源已连接但数据未能及时送达，请检查片源网络后重试"
        } else {
            "Emby 请求响应超时，请检查片源服务和网络后重试"
        }
    } else if error.is_connect() {
        "无法连接 Emby，请检查片源地址、端口、DNS 或 HTTPS 证书"
    } else if reading {
        "Emby 响应传输中断，请检查片源网络后重试"
    } else {
        "Emby 请求失败，请检查片源网络和 HTTPS 证书后重试"
    }
}
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
        .map_err(|error| request_error(&error, false))?;
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
        let chunk = chunk.map_err(|error| request_error(&error, true))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn silent_emby_headers_and_body_have_bounded_private_diagnostics() {
        for reading in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                stream.read(&mut request).await.unwrap();
                if reading {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n")
                        .await
                        .unwrap();
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            });
            let response = reqwest::Client::new()
                .get(format!(
                    "http://{address}/PlaybackInfo?api_key=never-log-this"
                ))
                .timeout(Duration::from_millis(100))
                .send()
                .await;
            let error = if reading {
                response.unwrap().bytes().await.unwrap_err()
            } else {
                response.unwrap_err()
            };
            assert!(error.is_timeout());
            let message = request_error(&error, reading);
            assert!(message.contains("Emby") && message.contains("超时"));
            assert_eq!(message.contains("读取"), reading);
            assert!(
                !message.contains("api_key")
                    && !message.contains("never-log-this")
                    && !message.contains("127.0.0.1")
            );
            server.abort();
        }
    }
}

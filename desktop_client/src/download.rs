use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest,Sha256};
use std::{fs,io::{Read,Write},path::Path,time::{Duration,Instant}};

#[derive(Deserialize)]
pub struct Artifact {pub url:String,pub sha256:String,pub size:u64}
pub fn matches(path:&Path,a:&Artifact)->bool{
    if fs::metadata(path).map(|m|m.len()).ok()!=Some(a.size){return false;}
    let Ok(mut f)=fs::File::open(path) else{return false;};let mut hash=Sha256::new();let mut buffer=[0;65536];
    loop{match f.read(&mut buffer){Ok(0)=>break,Ok(n)=>hash.update(&buffer[..n]),Err(_)=>return false}}
    format!("{:x}",hash.finalize())==a.sha256
}
pub async fn fetch(path:&Path,a:&Artifact,limit:u64,http:&reqwest::Client,progress:impl Fn(Value))->Result<(),String>{
    if a.size==0||a.size>limit||a.sha256.len()!=64||!a.sha256.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("插件下载清单无效".into());}
    let url=reqwest::Url::parse(&a.url).map_err(|_|"插件地址无效")?;
    if !matches!(url.scheme(),"http"|"https")||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some(){return Err("插件地址无效".into());}
    let report=|received|progress(json!({"type":"pluginDownload","sha256":a.sha256,"received":received,"total":a.size}));
    if matches(path,a){report(a.size);return Ok(());}
    fs::create_dir_all(path.parent().ok_or("下载目录无效")?).map_err(|_|"无法创建下载目录")?;
    let part=path.with_extension("part");let mut size=fs::metadata(&part).map(|m|m.len()).unwrap_or(0);
    if size>=a.size {if size==a.size&&matches(&part,a){if path.exists(){fs::remove_file(path).map_err(|_|"旧文件被占用")?;}fs::rename(&part,path).map_err(|_|"保存插件失败")?;report(size);return Ok(());}fs::remove_file(&part).map_err(|_|"无法重置下载")?;size=0;}
    report(size);let mut request=http.get(url).header("Accept-Encoding","identity").timeout(Duration::from_secs(150));if size>0{request=request.header("Range",format!("bytes={size}-"));}
    let response=request.send().await.map_err(|_|"插件下载连接失败，重试可继续")?;
    if response.status()==206 {let expected=format!("bytes {}-{}/{}",size,a.size-1,a.size);if response.headers().get("content-range").and_then(|v|v.to_str().ok())!=Some(expected.as_str()){let _=fs::remove_file(&part);return Err("插件续传范围无效".into());}}
    else if response.status()==200 {size=0;}else{return Err(format!("插件下载失败：{}，重试可继续",response.status()));}
    if response.content_length().is_some_and(|n|n>a.size-size){return Err("插件文件大小异常".into());}
    let mut file=fs::OpenOptions::new().create(true).write(true).append(size>0).truncate(size==0).open(&part).map_err(|_|"下载文件写入失败")?;
    let mut stream=response.bytes_stream();let mut last=Instant::now();
    while let Some(bytes)=stream.next().await {let bytes=bytes.map_err(|_|"插件下载中断，重试可继续")?;size+=bytes.len() as u64;if size>a.size{drop(file);let _=fs::remove_file(&part);return Err("插件文件超过声明大小".into());}file.write_all(&bytes).map_err(|_|"下载文件写入失败")?;if last.elapsed()>Duration::from_millis(200){report(size);last=Instant::now();}}
    file.sync_all().map_err(|_|"下载文件保存失败")?;drop(file);
    if size!=a.size{return Err("插件下载中断，重试可继续".into());}
    if !matches(&part,a){let _=fs::remove_file(&part);return Err("插件完整性校验失败，请重试".into());}
    if path.exists(){fs::remove_file(path).map_err(|_|"旧文件被占用")?;}
    fs::rename(&part,path).map_err(|_|"插件保存失败")?;report(size);Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    #[tokio::test]
    async fn interrupted_download_resumes_and_verifies_hash() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let bytes=vec![b'x';131072];let body=bytes.clone();
        let server=std::thread::spawn(move||{
            for attempt in 0..2 {
                let (mut socket,_)=listener.accept().unwrap();let mut request=Vec::new();
                while !request.ends_with(b"\r\n\r\n"){let mut byte=[0];socket.read_exact(&mut byte).unwrap();request.push(byte[0]);}
                let request=String::from_utf8(request).unwrap().to_lowercase();
                if attempt==0 {
                    assert!(!request.contains("range:"));
                    write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                    socket.write_all(&body[..65536]).unwrap();
                }else{
                    let from=request.lines().find_map(|line|line.strip_prefix("range: bytes=")).unwrap().trim_end_matches('-').parse::<usize>().unwrap();
                    assert!(from>0&&from<=65536);
                    write!(socket,"HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",body.len()-from,from,body.len()-1,body.len()).unwrap();
                    socket.write_all(&body[from..]).unwrap();
                }
            }
        });
        let dir=std::env::temp_dir().join(format!("cyber-download-{}-{}",std::process::id(),address.port()));
        let path=dir.join("fixture.json");
        let a=Artifact{url:format!("http://{address}/package"),sha256:format!("{:x}",Sha256::digest(&bytes)),size:bytes.len() as u64};
        let client=reqwest::Client::new();
        assert!(fetch(&path,&a,200000,&client,|_|{}).await.is_err());
        assert!(!path.exists());assert!(fs::metadata(path.with_extension("part")).unwrap().len()>0);
        fetch(&path,&a,200000,&client,|_|{}).await.unwrap();
        assert!(matches(&path,&a));assert!(!path.with_extension("part").exists());
        server.join().unwrap();fs::remove_file(path).unwrap();fs::remove_dir(dir).unwrap();
    }
}

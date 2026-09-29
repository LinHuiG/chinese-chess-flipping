//! v2 帧边界与 TCP 密码学。固定头 17 字节：magic/总长/控制长/包体长/version/kind/flags。
use aes_gcm::{aead::AeadInPlace, Aes256Gcm, KeyInit};
use hkdf::Hkdf;
use p256::{
    pkcs8::{DecodePublicKey, EncodePublicKey},
    PublicKey, SecretKey,
};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use zeroize::{Zeroize, Zeroizing};

pub type Result<T> = std::result::Result<T, String>;
// 完整入站帧及已校验的长度字段；加密与明文共用同一字节布局。
pub struct Frame {
    pub bytes: Vec<u8>,
    pub kind: u8,
    pub x: usize,
    pub encrypted: bool,
}
// 网络字节序读取长度；调用者先保证固定头完整。
fn u32at(b: &[u8], p: usize) -> usize {
    u32::from_be_bytes(b[p..p + 4].try_into().unwrap()) as usize
}
// 分配包体前校验版本、标志和总长，控制头最多 4 KiB、正文最多 64 KiB。
fn check(h: &[u8]) -> Result<usize> {
    if h.len() < 17 || h[..2] != [252, 252] || h[14] != 2 || h[15] == 0 || h[16] > 1 {
        return Err("Invalid header".into());
    }
    let (n, x, y) = (u32at(h, 2), u32at(h, 6), u32at(h, 10));
    if !(2..=4096).contains(&x) || y > 65536 || n != 17 + x + y + if h[16] == 1 { 28 } else { 0 } {
        return Err("Invalid length".into());
    }
    Ok(n)
}
// TCP 是字节流，按长度读取一帧，天然处理拆包/粘包。
pub async fn read<R: AsyncRead + Unpin>(r: &mut R) -> Result<Frame> {
    let mut h = [0; 17];
    r.read_exact(&mut h).await.map_err(|_| "Read failed")?;
    let n = check(&h)?;
    let mut bytes = Vec::with_capacity(n);
    bytes.extend_from_slice(&h);
    bytes.resize(n, 0);
    r.read_exact(&mut bytes[17..])
        .await
        .map_err(|_| "Read failed")?;
    Ok(Frame {
        kind: h[15],
        x: u32at(&h, 6),
        encrypted: h[16] == 1,
        bytes,
    })
}
// 构造固定头；AES-GCM 额外占用 12 字节 nonce 和 16 字节认证标签，不再叠加 CRC。
fn header(kind: u8, x: usize, y: usize, encrypted: bool) -> Result<Vec<u8>> {
    let n = 17 + x + y + if encrypted { 28 } else { 0 };
    let mut b = Vec::with_capacity(n);
    b.extend_from_slice(&[252, 252]);
    for v in [n, x, y] {
        b.extend_from_slice(&(v as u32).to_be_bytes())
    }
    b.extend_from_slice(&[2, kind, encrypted as u8]);
    check(&b)?;
    Ok(b)
}
// WS 或握手明文封帧，只拼接一次控制头和正文。
pub fn plain(kind: u8, control: &[u8], body: &[u8]) -> Result<Vec<u8>> {
    let mut b = header(kind, control.len(), body.len(), false)?;
    b.extend_from_slice(control);
    b.extend_from_slice(body);
    Ok(b)
}
// 明文访问必须先排除加密标志，避免把密文误作 JSON 控制消息。
impl Frame {
    pub fn plaintext(&self) -> Result<(&[u8], &[u8])> {
        if self.encrypted {
            return Err("Encrypted handshake".into());
        }
        Ok((&self.bytes[17..17 + self.x], &self.bytes[17 + self.x..]))
    }
}
// WS 已给出完整帧，直接借用输入字节；不再为了复用 TCP read 分配和复制整个包体。
pub fn plaintext(bytes: &[u8]) -> Result<(u8, &[u8], &[u8])> {
    if check(bytes)? != bytes.len() || bytes[16] != 0 {
        return Err("Invalid plain frame".into());
    }
    let x = u32at(bytes, 6);
    Ok((bytes[15], &bytes[17..17 + x], &bytes[17 + x..]))
}
// 单方向加密状态：发送和接收各有独立密钥、nonce 前缀和递增序号。
pub struct Cipher {
    cipher: Aes256Gcm,
    prefix: [u8; 4],
    sequence: u64,
}
impl Cipher {
    // 密钥只保留在 AES 对象中；派生临时材料在 derive 结束时清零。
    fn new(key: &[u8], prefix: &[u8]) -> Self {
        Self {
            cipher: Aes256Gcm::new_from_slice(key).unwrap(),
            prefix: prefix.try_into().unwrap(),
            sequence: 0,
        }
    }
    // nonce = 4 字节方向前缀 + 8 字节序号；到上限关闭会话，绝不重复使用 nonce。
    fn nonce(&self) -> Result<[u8; 12]> {
        if self.sequence >= 0xffff_ffff {
            return Err("Session expired".into());
        }
        let mut n = [0; 12];
        n[..4].copy_from_slice(&self.prefix);
        n[4..].copy_from_slice(&self.sequence.to_be_bytes());
        Ok(n)
    }
    // 固定头作为 AAD 认证，控制区和正文一起加密；按连接顺序递增序号。
    pub fn encrypt(&mut self, kind: u8, control: &[u8], body: &[u8]) -> Result<Vec<u8>> {
        let mut b = header(kind, control.len(), body.len(), true)?;
        let n = self.nonce()?;
        let aad: [u8; 17] = b[..17].try_into().unwrap();
        b.extend_from_slice(&n);
        b.extend_from_slice(control);
        b.extend_from_slice(body);
        let tag = self
            .cipher
            .encrypt_in_place_detached(&n.into(), &aad, &mut b[29..])
            .map_err(|_| "Encryption failed")?;
        b.extend_from_slice(&tag);
        self.sequence += 1;
        Ok(b)
    }
    // 要求精确的下一个 nonce，拒绝重放和乱序；认证通过前不处理任何控制字段。
    pub fn decrypt(&mut self, mut f: Frame) -> Result<(u8, bytes::Bytes, usize)> {
        if !f.encrypted {
            return Err("Plaintext forbidden".into());
        }
        let n = self.nonce()?;
        if f.bytes[17..29] != n {
            return Err("Nonce sequence".into());
        }
        let aad: [u8; 17] = f.bytes[..17].try_into().unwrap();
        let end = f.bytes.len() - 16;
        let tag: [u8; 16] = f.bytes[end..].try_into().unwrap();
        self.cipher
            .decrypt_in_place_detached(&n.into(), &aad, &mut f.bytes[29..end], &tag.into())
            .map_err(|_| "Authentication failed")?;
        self.sequence += 1;
        f.bytes.truncate(end);
        // 转成共享切片，跳过固定头和 nonce；不通过 drain 搬动整个正文。
        Ok((f.kind, bytes::Bytes::from(f.bytes).slice(29..), f.x))
    }
}
// 握手内容为随机 32 字节 salt 加 DER 编码 P-256 公钥。
pub fn hello(key: &SecretKey) -> Vec<u8> {
    let mut b = vec![0; 32];
    OsRng.fill_bytes(&mut b);
    b.extend_from_slice(key.public_key().to_public_key_der().unwrap().as_bytes());
    b
}
// ECDH 共享秘密经 HKDF 派生 64 字节双向密钥和 8 字节双向 nonce 前缀。
// 双方随机量和握手摘要一起绑定到本次连接；派生材料用 Zeroizing 擦除。
pub fn derive(
    key: &SecretKey,
    server: &[u8],
    client: &[u8],
    transcript: &[u8],
) -> Result<(Cipher, Cipher)> {
    if !(33..=256).contains(&client.len()) {
        return Err("Invalid peer key".into());
    }
    let peer = PublicKey::from_public_key_der(&client[32..]).map_err(|_| "Invalid P-256 key")?;
    let secret = p256::ecdh::diffie_hellman(key.to_nonzero_scalar(), peer.as_affine());
    let mut salt = Sha256::new();
    salt.update(&server[..32]);
    salt.update(&client[..32]);
    let mut info = b"chess-flipping/tcp/v2".to_vec();
    info.extend_from_slice(transcript);
    let mut material = Zeroizing::new([0u8; 72]);
    Hkdf::<Sha256>::new(Some(&salt.finalize()), secret.raw_secret_bytes())
        .expand(&info, material.as_mut())
        .map_err(|_| "HKDF")?;
    let receive = Cipher::new(&material[..32], &material[64..68]);
    let send = Cipher::new(&material[32..64], &material[68..72]);
    material.zeroize();
    Ok((send, receive))
}

// 验证 v2 帧边界及加密完整性，特别是移除 CRC 后仍保留 GCM 认证和重放拒绝。
#[cfg(test)]
mod tests {
    use super::*;
    // 截断、旧版本和尾部多余字节都不能被当成完整 WS 帧。
    #[test]
    fn plain_boundaries() {
        let mut b = plain(16, b"{}", b"opaque").unwrap();
        assert_eq!(plaintext(&b).unwrap().2, b"opaque");
        assert!(plaintext(&b[..b.len() - 1]).is_err());
        b[14] = 1;
        assert!(plaintext(&b).is_err());
        b[14] = 2;
        b.push(0);
        assert!(plaintext(&b).is_err());
    }
    // AES-GCM 校验固定头与正文，接收序号只在认证成功后推进。
    #[tokio::test]
    async fn authenticated_frame_replay_and_tamper() {
        let mut tx = Cipher::new(&[1; 32], &[2; 4]);
        let mut rx = Cipher::new(&[1; 32], &[2; 4]);
        let b = tx.encrypt(16, b"{}", b"opaque").unwrap();
        let mut bad = b.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(rx
            .decrypt(read(&mut bad.as_slice()).await.unwrap())
            .is_err());
        let (_, plain, x) = rx.decrypt(read(&mut b.as_slice()).await.unwrap()).unwrap();
        assert_eq!(&plain[x..], b"opaque");
        assert!(rx.decrypt(read(&mut b.as_slice()).await.unwrap()).is_err());
    }
}

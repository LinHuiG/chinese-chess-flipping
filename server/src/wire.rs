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
pub struct Frame {
    pub bytes: Vec<u8>,
    pub kind: u8,
    pub x: usize,
    pub encrypted: bool,
}
fn u32at(b: &[u8], p: usize) -> usize {
    u32::from_be_bytes(b[p..p + 4].try_into().unwrap()) as usize
}
fn check(h: &[u8]) -> Result<usize> {
    if h.len() < 21 || h[..2] != [252, 252] || h[14] != 1 || h[15] == 0 || h[16] > 1 {
        return Err("Invalid header".into());
    }
    let (n, x, y) = (u32at(h, 2), u32at(h, 6), u32at(h, 10));
    if !(2..=4096).contains(&x) || y > 65536 || n != 21 + x + y + if h[16] == 1 { 28 } else { 0 } {
        return Err("Invalid length".into());
    }
    Ok(n)
}
fn crc(b: &[u8]) -> u32 {
    let mut c = crc32fast::Hasher::new();
    c.update(&b[..17]);
    c.update(&b[21..]);
    c.finalize()
}
pub async fn read<R: AsyncRead + Unpin>(r: &mut R) -> Result<Frame> {
    let mut h = [0; 21];
    r.read_exact(&mut h).await.map_err(|_| "Read failed")?;
    let n = check(&h)?;
    let mut bytes = Vec::with_capacity(n);
    bytes.extend_from_slice(&h);
    bytes.resize(n, 0);
    r.read_exact(&mut bytes[21..])
        .await
        .map_err(|_| "Read failed")?;
    if crc(&bytes) != u32at(&h, 17) as u32 {
        return Err("CRC mismatch".into());
    }
    Ok(Frame {
        kind: h[15],
        x: u32at(&h, 6),
        encrypted: h[16] == 1,
        bytes,
    })
}
fn header(kind: u8, x: usize, y: usize, encrypted: bool) -> Result<Vec<u8>> {
    let n = 21 + x + y + if encrypted { 28 } else { 0 };
    let mut b = Vec::with_capacity(n);
    b.extend_from_slice(&[252, 252]);
    for v in [n, x, y] {
        b.extend_from_slice(&(v as u32).to_be_bytes())
    }
    b.extend_from_slice(&[1, kind, encrypted as u8, 0, 0, 0, 0]);
    check(&b)?;
    Ok(b)
}
pub fn plain(kind: u8, control: &[u8], body: &[u8]) -> Result<Vec<u8>> {
    let mut b = header(kind, control.len(), body.len(), false)?;
    b.extend_from_slice(control);
    b.extend_from_slice(body);
    let c = crc(&b);
    b[17..21].copy_from_slice(&c.to_be_bytes());
    Ok(b)
}
impl Frame {
    pub fn plaintext(&self) -> Result<(&[u8], &[u8])> {
        if self.encrypted {
            return Err("Encrypted handshake".into());
        }
        Ok((&self.bytes[21..21 + self.x], &self.bytes[21 + self.x..]))
    }
}
pub struct Cipher {
    cipher: Aes256Gcm,
    prefix: [u8; 4],
    sequence: u64,
}
impl Cipher {
    fn new(key: &[u8], prefix: &[u8]) -> Self {
        Self {
            cipher: Aes256Gcm::new_from_slice(key).unwrap(),
            prefix: prefix.try_into().unwrap(),
            sequence: 0,
        }
    }
    fn nonce(&self) -> Result<[u8; 12]> {
        if self.sequence >= 0xffff_ffff {
            return Err("Session expired".into());
        }
        let mut n = [0; 12];
        n[..4].copy_from_slice(&self.prefix);
        n[4..].copy_from_slice(&self.sequence.to_be_bytes());
        Ok(n)
    }
    pub fn encrypt(&mut self, kind: u8, control: &[u8], body: &[u8]) -> Result<Vec<u8>> {
        let mut b = header(kind, control.len(), body.len(), true)?;
        let n = self.nonce()?;
        let aad: [u8; 17] = b[..17].try_into().unwrap();
        b.extend_from_slice(&n);
        b.extend_from_slice(control);
        b.extend_from_slice(body);
        let tag = self
            .cipher
            .encrypt_in_place_detached(&n.into(), &aad, &mut b[33..])
            .map_err(|_| "Encryption failed")?;
        b.extend_from_slice(&tag);
        let c = crc(&b);
        b[17..21].copy_from_slice(&c.to_be_bytes());
        self.sequence += 1;
        Ok(b)
    }
    pub fn decrypt(&mut self, mut f: Frame) -> Result<(u8, Vec<u8>, usize)> {
        if !f.encrypted {
            return Err("Plaintext forbidden".into());
        }
        let n = self.nonce()?;
        if f.bytes[21..33] != n {
            return Err("Nonce sequence".into());
        }
        let aad: [u8; 17] = f.bytes[..17].try_into().unwrap();
        let end = f.bytes.len() - 16;
        let tag: [u8; 16] = f.bytes[end..].try_into().unwrap();
        self.cipher
            .decrypt_in_place_detached(&n.into(), &aad, &mut f.bytes[33..end], &tag.into())
            .map_err(|_| "Authentication failed")?;
        self.sequence += 1;
        f.bytes.truncate(end);
        f.bytes.drain(..33);
        Ok((f.kind, f.bytes, f.x))
    }
}
pub fn hello(key: &SecretKey) -> Vec<u8> {
    let mut b = vec![0; 32];
    OsRng.fill_bytes(&mut b);
    b.extend_from_slice(key.public_key().to_public_key_der().unwrap().as_bytes());
    b
}
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
    let mut info = b"chess-flipping/tcp/v1".to_vec();
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

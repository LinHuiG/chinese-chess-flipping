use aes_gcm::{aead::AeadInPlace, Aes256Gcm, KeyInit};
use hkdf::Hkdf;
use p256::{
    pkcs8::{DecodePublicKey, EncodePublicKey},
    PublicKey, SecretKey,
};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use tokio::io::{AsyncRead, AsyncReadExt};
use zeroize::Zeroizing;
pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone)]
pub struct Packet {
    pub kind: u8,
    pub control: Vec<u8>,
    pub body: Vec<u8>,
}
impl Packet {
    pub fn new(kind: u8, control: impl AsRef<[u8]>, body: impl AsRef<[u8]>) -> Self {
        Self {
            kind,
            control: control.as_ref().to_vec(),
            body: body.as_ref().to_vec(),
        }
    }
    pub fn plain(&self) -> Result<Vec<u8>> {
        let mut b = header(self, false)?;
        b.extend_from_slice(&self.control);
        b.extend_from_slice(&self.body);
        Ok(b)
    }
    pub fn parse(b: &[u8]) -> Result<Self> {
        check(b)?;
        if b[16] != 0 {
            return Err("Encrypted frame".into());
        }
        let x = number(b, 6);
        Ok(Self::new(b[15], &b[17..17 + x], &b[17 + x..]))
    }
    pub fn fields(&self) -> Result<BTreeMap<&str, &str>> {
        control(&self.control)
    }
}
fn number(b: &[u8], n: usize) -> usize {
    u32::from_be_bytes(b[n..n + 4].try_into().unwrap()) as usize
}
fn length(b: &[u8]) -> Result<usize> {
    if b.len() < 17 || b[..2] != [252, 252] || b[14] != 3 || b[15] == 0 || b[16] > 1 {
        return Err("Invalid frame header".into());
    }
    let n = number(b, 2);
    let x = number(b, 6);
    let y = number(b, 10);
    if x > 4096 || y > 65536 || n != 17 + x + y + if b[16] == 1 { 28 } else { 0 } {
        return Err("Invalid frame length".into());
    }
    Ok(n)
}
fn check(b: &[u8]) -> Result<()> {
    if length(b)? != b.len() {
        return Err("Truncated frame".into());
    }
    Ok(())
}
fn header(p: &Packet, encrypted: bool) -> Result<Vec<u8>> {
    let mut b = vec![252, 252];
    for n in [
        17 + p.control.len() + p.body.len() + if encrypted { 28 } else { 0 },
        p.control.len(),
        p.body.len(),
    ] {
        b.extend_from_slice(&(n as u32).to_be_bytes())
    }
    b.extend_from_slice(&[3, p.kind, encrypted as u8]);
    length(&b)?;
    Ok(b)
}
pub async fn read(r: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let mut b = vec![0; 17];
    r.read_exact(&mut b).await.map_err(|_| "读取失败")?;
    let n = length(&b)?;
    b.resize(n, 0);
    r.read_exact(&mut b[17..]).await.map_err(|_| "读取失败")?;
    Ok(b)
}
pub fn control(b: &[u8]) -> Result<BTreeMap<&str, &str>> {
    let text = std::str::from_utf8(b).map_err(|_| "Invalid control UTF8")?;
    if b.len() > 4096 || (!text.is_empty() && !text.ends_with('\n')) {
        return Err("Invalid control".into());
    }
    let mut fields = BTreeMap::new();
    for line in text.split_terminator('\n') {
        let (k, v) = line.split_once(':').ok_or("Invalid control line")?;
        if !k.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            || !k
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || v.bytes().any(|c| c == 0 || c == b'\r')
        {
            return Err("Invalid control line".into());
        }
        if fields.insert(k, v).is_some()
            && matches!(
                k,
                "op" | "requestId" | "roomId" | "to" | "from" | "ok" | "error"
            )
        {
            return Err("Duplicate route".into());
        }
    }
    Ok(fields)
}
pub fn valid_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn random_id() -> String {
    let mut b = [0; 16];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub struct Cipher {
    aes: Aes256Gcm,
    prefix: [u8; 4],
    next: u64,
    highest: Option<u64>,
    seen: BTreeSet<u64>,
}
impl Cipher {
    fn new(key: &[u8], prefix: &[u8]) -> Self {
        Self {
            aes: Aes256Gcm::new_from_slice(key).unwrap(),
            prefix: prefix.try_into().unwrap(),
            next: 0,
            highest: None,
            seen: BTreeSet::new(),
        }
    }
    fn nonce(&self) -> Result<[u8; 12]> {
        if self.next >= 0xffff_ffff {
            return Err("Session exhausted".into());
        }
        let mut n = [0; 12];
        n[..4].copy_from_slice(&self.prefix);
        n[4..].copy_from_slice(&self.next.to_be_bytes());
        Ok(n)
    }
    pub fn seal(&mut self, aad: &[u8], data: &[u8]) -> Result<Vec<u8>> {
        let n = self.nonce()?;
        let mut b = data.to_vec();
        let tag = self
            .aes
            .encrypt_in_place_detached(&n.into(), aad, &mut b)
            .map_err(|_| "Encryption failed")?;
        self.next += 1;
        let mut out = n.to_vec();
        out.extend(b);
        out.extend(tag);
        Ok(out)
    }
    pub fn encrypt(&mut self, p: &Packet) -> Result<Vec<u8>> {
        let mut b = header(p, true)?;
        let mut data = p.control.clone();
        data.extend_from_slice(&p.body);
        let payload = self.seal(&b, &data)?;
        b.extend(payload);
        Ok(b)
    }
    pub fn decrypt(&mut self, b: &[u8], unordered: bool) -> Result<Packet> {
        check(b)?;
        if b[16] != 1 || b[17..21] != self.prefix {
            return Err("Cipher mismatch".into());
        }
        let n: [u8; 12] = b[17..29].try_into().unwrap();
        let seq = u64::from_be_bytes(n[4..].try_into().unwrap());
        if seq >= 0xffff_ffff
            || (!unordered && seq != self.next)
            || (unordered
                && (self.seen.contains(&seq)
                    || self.highest.is_some_and(|h| h.saturating_sub(seq) >= 256)))
        {
            return Err("Replay".into());
        }
        let end = b.len() - 16;
        let mut plain = b[29..end].to_vec();
        let tag: [u8; 16] = b[end..].try_into().unwrap();
        self.aes
            .decrypt_in_place_detached(&n.into(), &b[..17], &mut plain, &tag.into())
            .map_err(|_| "Authentication failed")?;
        if unordered {
            let h = self.highest.unwrap_or(seq).max(seq);
            self.highest = Some(h);
            self.seen.insert(seq);
            self.seen.retain(|s| h.saturating_sub(*s) < 256);
        } else {
            self.next += 1;
        }
        let x = number(b, 6);
        Ok(Packet::new(b[15], &plain[..x], &plain[x..]))
    }
}
pub fn tcp_keys(
    key: &SecretKey,
    server: &[u8],
    client: &[u8],
    transcript: &[u8],
) -> Result<(Cipher, Cipher)> {
    if !(33..=256).contains(&server.len()) {
        return Err("Invalid server key".into());
    }
    let peer = PublicKey::from_public_key_der(&server[32..]).map_err(|_| "Invalid P256 key")?;
    let shared = p256::ecdh::diffie_hellman(key.to_nonzero_scalar(), peer.as_affine());
    let mut salts = server[..32].to_vec();
    salts.extend_from_slice(&client[..32]);
    let mut info = b"cyber-room/tcp/v3".to_vec();
    info.extend_from_slice(transcript);
    derive(
        shared.raw_secret_bytes(),
        &Sha256::digest(salts),
        &info,
        true,
    )
}
pub fn udp_keys(context: &str, master: &[u8], initiator: bool) -> Result<(Cipher, Cipher)> {
    if !valid_id(context) || master.len() != 32 {
        return Err("Invalid UDP key".into());
    }
    derive(
        master,
        &Sha256::digest(context.as_bytes()),
        b"cyber-room/udp/v3",
        initiator,
    )
}
fn derive(secret: &[u8], salt: &[u8], info: &[u8], first: bool) -> Result<(Cipher, Cipher)> {
    let mut m = Zeroizing::new([0u8; 72]);
    Hkdf::<Sha256>::new(Some(salt), secret)
        .expand(info, &mut *m)
        .map_err(|_| "HKDF failed")?;
    let a = Cipher::new(&m[..32], &m[64..68]);
    let b = Cipher::new(&m[32..64], &m[68..]);
    Ok(if first { (a, b) } else { (b, a) })
}
pub fn hello(key: &SecretKey) -> Vec<u8> {
    let mut b = vec![0; 32];
    OsRng.fill_bytes(&mut b);
    b.extend_from_slice(key.public_key().to_public_key_der().unwrap().as_bytes());
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tcp_tamper_and_out_of_order_do_not_advance_receive_nonce() {
        let mut send = Cipher::new(&[3; 32], &[4; 4]);
        let mut receive = Cipher::new(&[3; 32], &[4; 4]);
        let first = send.encrypt(&Packet::new(16, "op:101\n", b"{}")).unwrap();
        let second = send.encrypt(&Packet::new(16, "op:103\n", b"{}")).unwrap();
        assert!(receive.decrypt(&second, false).is_err());
        let mut damaged = first.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(receive.decrypt(&damaged, false).is_err());
        assert_eq!(
            receive
                .decrypt(&first, false)
                .unwrap()
                .fields()
                .unwrap()
                .get("op"),
            Some(&"101")
        );
        assert!(receive.decrypt(&first, false).is_err());
        assert!(receive.decrypt(&second, false).is_ok());
    }
    #[test]
    fn frame_and_control_boundaries_reject_ambiguous_routes() {
        let p = Packet::new(64, "from:sender\n", vec![0; 65536]);
        let b = p.plain().unwrap();
        assert_eq!(Packet::parse(&b).unwrap().body.len(), 65536);
        assert!(Packet::parse(&b[..b.len() - 1]).is_err());
        assert!(Packet::new(64, b"", vec![0; 65537]).plain().is_err());
        assert!(control(b"from:a\nfrom:b\n").is_err());
        assert!(control(b"op:200\r\n").is_err());
        assert!(control(b"to:missing-newline").is_err());
    }
    #[test]
    fn udp_accepts_fragment_reordering_and_rejects_replay() {
        let context = "0123456789abcdef0123456789abcdef";
        let (mut send, _) = udp_keys(context, &[7; 32], true).unwrap();
        let (_, mut receive) = udp_keys(context, &[7; 32], false).unwrap();
        let frames = (0..80)
            .map(|i| {
                send.encrypt(&Packet::new(64, "transport:chunk\n", [i]))
                    .unwrap()
            })
            .collect::<Vec<_>>();
        for b in frames.iter().rev() {
            assert!(receive.decrypt(b, true).is_ok());
        }
        assert!(receive.decrypt(&frames[0], true).is_err());
        let mut bad = send
            .encrypt(&Packet::new(64, "type:voice\n", b"opaque"))
            .unwrap();
        *bad.last_mut().unwrap() ^= 1;
        assert!(receive.decrypt(&bad, true).is_err());
    }
}

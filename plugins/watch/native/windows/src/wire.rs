//! Only the shared unencrypted frame envelope. Encryption and connections stay in the host.
use std::collections::BTreeMap;
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
    pub fn fields(&self) -> Result<BTreeMap<&str, &str>, String> {
        let text = std::str::from_utf8(&self.control).map_err(|_| "Invalid control")?;
        let mut out = BTreeMap::new();
        for line in text.lines() {
            let (k, v) = line.split_once(':').ok_or("Invalid control")?;
            if k.is_empty() || out.insert(k, v).is_some() {
                return Err("Invalid control".into());
            }
        }
        Ok(out)
    }
    pub fn plain(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(17 + self.control.len() + self.body.len());
        out.extend_from_slice(&[0xfc, 0xfc]);
        out.extend_from_slice(&((17 + self.control.len() + self.body.len()) as u32).to_be_bytes());
        out.extend_from_slice(&(self.control.len() as u32).to_be_bytes());
        out.extend_from_slice(&(self.body.len() as u32).to_be_bytes());
        out.extend_from_slice(&[3, self.kind, 0]);
        out.extend_from_slice(&self.control);
        out.extend_from_slice(&self.body);
        out
    }
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 17
            || bytes.len() > 65536
            || bytes[..2] != [0xfc, 0xfc]
            || bytes[14] != 3
            || bytes[16] != 0
        {
            return Err("Invalid packet".into());
        }
        let n = u32::from_be_bytes(bytes[6..10].try_into().unwrap()) as usize;
        let total = u32::from_be_bytes(bytes[2..6].try_into().unwrap()) as usize;
        let body = u32::from_be_bytes(bytes[10..14].try_into().unwrap()) as usize;
        if total != bytes.len() || n > 4096 || 17 + n > bytes.len() || body != bytes.len() - 17 - n
        {
            return Err("Invalid packet".into());
        }
        Ok(Self::new(bytes[15], &bytes[17..17 + n], &bytes[17 + n..]))
    }
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

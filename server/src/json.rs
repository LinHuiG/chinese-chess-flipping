//! 严格解析服务器要理解的控制 JSON；棋局转发正文不会进入本模块。
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

// 递归解析时拒绝重复字段，避免同一 JSON 在不同客户端/服务端被解释成不同命令。
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Strict;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON value")
            }
            // 标量直接保留类型；JSON 不允许 NaN/Infinity。
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strict, E> {
                Number::from_f64(v)
                    .map(|v| Strict(Value::Number(v)))
                    .ok_or_else(|| E::custom("number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Strict, E> {
                Ok(Strict(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            // 数组元素递归校验，嵌套对象也不能绕过重复字段检查。
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element::<Strict>()? {
                    v.push(x.0)
                }
                Ok(Strict(Value::Array(v)))
            }
            // 遇到重复键立即拒绝，不采用静默覆盖的默认行为。
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Strict, A::Error> {
                let mut v = Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if v.contains_key(&k) {
                        return Err(de::Error::custom("duplicate field"));
                    }
                    v.insert(k, a.next_value::<Strict>()?.0);
                }
                Ok(Strict(Value::Object(v)))
            }
        }
        d.deserialize_any(V)
    }
}
// 入口只接受一个完整对象，拒绝对象后的垃圾或第二个 JSON 值。
pub fn object(bytes: &[u8]) -> Result<Value, String> {
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let value = Strict::deserialize(&mut d).map_err(|_| "Invalid JSON")?.0;
    d.end().map_err(|_| "Trailing JSON")?;
    if !value.is_object() {
        return Err("Expected object".into());
    }
    Ok(value)
}
// 协议中的操作/会话编号统一为 32 位小写十六进制字符串。
pub fn hex_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
// 读取握手必填文本，限制长度；UTF-16 计数与 Android 字符串边界一致。
pub fn field<'a>(v: &'a Value, k: &str, max: usize) -> Result<&'a str, String> {
    let s = v[k].as_str().ok_or("Missing field")?;
    if s.trim().is_empty() || s.encode_utf16().count() > max {
        return Err("Invalid field".into());
    }
    Ok(s)
}

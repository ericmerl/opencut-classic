//! ECMAScript-compatible canonical JSON for cross-runtime content identities.

use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_SAFE_UNSIGNED_INTEGER: u64 = MAX_SAFE_INTEGER as u64;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CanonicalJsonError {
    #[error("canonical JSON contains an unsafe integer at {path}: {value}")]
    UnsafeInteger { path: String, value: String },
    #[error("canonical JSON contains invalid Unicode at {path}")]
    InvalidUnicode { path: String },
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
}

/// Parses JSON while converting invalid UTF-8 or surrogate escapes into a typed blocker.
pub fn parse_json(bytes: &[u8]) -> Result<Value, CanonicalJsonError> {
    serde_json::from_slice(bytes).map_err(|error| {
        let message = error.to_string();
        if std::str::from_utf8(bytes).is_err() || message.to_ascii_lowercase().contains("surrogate")
        {
            CanonicalJsonError::InvalidUnicode { path: "$".into() }
        } else {
            CanonicalJsonError::InvalidJson(message)
        }
    })
}

/// Serializes a JSON value with UTF-16 key ordering and ECMAScript number formatting.
pub fn canonical_json(value: &Value) -> Result<String, CanonicalJsonError> {
    serialize_value(value, "$")
}

/// Returns the lowercase SHA-256 digest of the canonical UTF-8 bytes.
pub fn canonical_sha256(value: &Value) -> Result<String, CanonicalJsonError> {
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical_json(value)?.as_bytes())
    ))
}

/// Verifies that input bytes are already canonical and returns their SHA-256 digest.
pub fn verify_canonical_json(bytes: &[u8]) -> Result<String, CanonicalJsonError> {
    let value = parse_json(bytes)?;
    let canonical = canonical_json(&value)?;
    if canonical.as_bytes() != bytes {
        return Err(CanonicalJsonError::InvalidJson(
            "JSON bytes are not in canonical form".into(),
        ));
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn serialize_value(value: &Value, path: &str) -> Result<String, CanonicalJsonError> {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            let serialized = entries
                .into_iter()
                .map(|(key, value)| {
                    let child_path = property_path(path, key);
                    serialize_value(value, &child_path).map(|value| {
                        format!(
                            "{}:{value}",
                            serde_json::to_string(key).expect("valid string")
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("{{{}}}", serialized.join(",")))
        }
        Value::Array(values) => {
            let serialized = values
                .iter()
                .enumerate()
                .map(|(index, value)| serialize_value(value, &format!("{path}[{index}]")))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", serialized.join(",")))
        }
        Value::Number(number) => serialize_number(number, path),
        _ => serde_json::to_string(value)
            .map_err(|error| CanonicalJsonError::InvalidJson(error.to_string())),
    }
}

fn serialize_number(number: &serde_json::Number, path: &str) -> Result<String, CanonicalJsonError> {
    if let Some(value) = number.as_i64() {
        if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
            return Err(CanonicalJsonError::UnsafeInteger {
                path: path.into(),
                value: value.to_string(),
            });
        }
    } else if let Some(value) = number.as_u64()
        && value > MAX_SAFE_UNSIGNED_INTEGER
    {
        return Err(CanonicalJsonError::UnsafeInteger {
            path: path.into(),
            value: value.to_string(),
        });
    }

    let value = number
        .as_f64()
        .ok_or_else(|| CanonicalJsonError::InvalidJson("non-finite number".into()))?;
    if value.fract() == 0.0 && value.abs() > MAX_SAFE_INTEGER as f64 {
        return Err(CanonicalJsonError::UnsafeInteger {
            path: path.into(),
            value: ryu_js::Buffer::new().format_finite(value).into(),
        });
    }
    if value == 0.0 {
        Ok("0".into())
    } else {
        Ok(ryu_js::Buffer::new().format_finite(value).into())
    }
}

fn property_path(parent: &str, key: &str) -> String {
    let mut chars = key.chars();
    let identifier = chars.next().is_some_and(|character| {
        character == '_' || character == '$' || character.is_ascii_alphabetic()
    }) && chars
        .all(|character| character == '_' || character == '$' || character.is_ascii_alphanumeric());
    if identifier {
        format!("{parent}.{key}")
    } else {
        format!(
            "{parent}[{}]",
            serde_json::to_string(key).expect("valid string")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn uses_utf16_order_ecmascript_numbers_and_negative_zero_policy() {
        let value = json!({ "\u{e000}": 2, "\u{10000}": 1, "tiny": 0.0000001, "zero": -0.0 });
        assert_eq!(
            canonical_json(&value).unwrap(),
            "{\"tiny\":1e-7,\"zero\":0,\"𐀀\":1,\"\":2}"
        );
    }

    #[test]
    fn reports_unsafe_integer_with_a_typed_path() {
        let value = json!({ "nested": [9_007_199_254_740_992_u64] });
        assert_eq!(
            canonical_json(&value),
            Err(CanonicalJsonError::UnsafeInteger {
                path: "$.nested[0]".into(),
                value: "9007199254740992".into(),
            })
        );
        let decimal: Value = serde_json::from_str("9007199254740992.0").unwrap();
        assert!(matches!(
            canonical_json(&decimal),
            Err(CanonicalJsonError::UnsafeInteger { .. })
        ));
    }

    #[test]
    fn reports_invalid_utf8_as_invalid_unicode() {
        assert_eq!(
            parse_json(b"{\"value\":\"\xff\"}"),
            Err(CanonicalJsonError::InvalidUnicode { path: "$".into() })
        );
    }
}

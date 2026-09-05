use canonical_json::{canonical_json, canonical_sha256, parse_json, verify_canonical_json};

const RUST_AUTHORED: &str = include_str!("fixtures/rust-authored-project-v2.json");
const JS_ADAPTER: &str = include_str!("fixtures/js-adapter-project-v2.json");

#[test]
fn rust_authored_projection_has_stable_bytes_and_digest() {
    let bytes = fixture_bytes(RUST_AUTHORED);
    let value = parse_json(bytes).unwrap();
    assert_eq!(canonical_json(&value).unwrap().as_bytes(), bytes);
    assert_eq!(
        canonical_sha256(&value).unwrap(),
        "2648107f8035791b951903b65c1899847dcd8aeaae5f5141737426922348106b"
    );
    assert_eq!(
        canonical_sha256(&value).unwrap(),
        verify_canonical_json(bytes).unwrap()
    );
}

#[test]
fn js_adapter_projection_is_canonical_and_has_stable_digest() {
    let bytes = fixture_bytes(JS_ADAPTER);
    assert_eq!(
        verify_canonical_json(bytes).unwrap(),
        "62a26c353c0751924733f40f476425a0bf9a3722c42975a32bebbd7a8d966554"
    );
}

fn fixture_bytes(value: &'static str) -> &'static [u8] {
    value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value)
        .as_bytes()
}

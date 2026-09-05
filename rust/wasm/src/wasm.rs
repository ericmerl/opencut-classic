#[cfg(target_arch = "wasm32")]
mod compositor;
#[cfg(target_arch = "wasm32")]
mod effects;
#[cfg(target_arch = "wasm32")]
mod gpu;
#[cfg(target_arch = "wasm32")]
mod masks;
#[cfg(target_arch = "wasm32")]
mod perf;

pub use comparison::*;
#[cfg(target_arch = "wasm32")]
pub use compositor::*;
pub use edit_plan::*;
#[cfg(target_arch = "wasm32")]
pub use effects::*;
#[cfg(target_arch = "wasm32")]
pub use gpu::*;
#[cfg(target_arch = "wasm32")]
pub use masks::*;
pub use media_foundation::*;
#[cfg(target_arch = "wasm32")]
pub use perf::*;
pub use project_state::*;
pub use review_evidence::*;
pub use time::*;

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen(typescript_custom_section)]
const RESOLVED_EDIT_OPERATION_TYPES: &str = r#"
export type ResolvedOutput<T> =
    T extends undefined ? null :
    T extends readonly (infer Item)[] ? ResolvedOutput<Item>[] :
    T extends object ? { [Key in keyof T]: ResolvedOutput<T[Key]> } :
    T;

export type ResolvedEditOperation = ResolvedOutput<EditOperation>;
"#;

#[cfg(all(test, target_arch = "wasm32"))]
mod tests {
    use edit_plan::{
        EditPlanEvaluationResponse, EvaluateEditPlanOptions, ProjectSnapshot, evaluate,
    };
    use js_sys::{Array, JSON, Object, Reflect};
    use tsify_next::Tsify;
    use wasm_bindgen::JsValue;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn validated_edit_plan_response_is_recursively_json_compatible() {
        let before: ProjectSnapshot = serde_json::from_str(include_str!(
            "../../crates/edit-plan/tests/fixtures/full-project-content-v1.json"
        ))
        .expect("valid full project fixture");
        let request: EvaluateEditPlanOptions = serde_json::from_value(serde_json::json!({
            "contractVersion": "opencut.edit-plan-preflight.v2",
            "source": {
                "connectionIdentity": {
                    "serverInstanceId": "server",
                    "editorInstanceId": "editor",
                    "editorSessionId": "session",
                    "connectionGeneration": 1,
                    "bridgeProtocolVersion": 2
                },
                "projectId": "project",
                "sceneId": "scene-main",
                "sessionRevision": 2,
                "canonicalProjectHash": "3925eec0bcfda9c81c325e8436b3744f0794875189f8a508bf3d51f802a5424c",
                "durableWriteVersion": 3,
                "saveReceiptId": "receipt",
                "saveOperationId": "save"
            },
            "capabilitySnapshot": {
                "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "editPlanReady": true,
                "providerExecution": "forbidden",
                "cost": { "status": "not-applicable" }
            },
            "policy": {
                "warningPolicy": "allow",
                "providerExecution": "forbidden",
                "costPolicy": "require-exact"
            },
            "description": "live three-operation JSON response regression",
            "operations": [
                {
                    "kind": "set_reframe",
                    "trackId": "track-main",
                    "elementId": "video-1",
                    "mode": "fit"
                },
                {
                    "kind": "insert_captions",
                    "captions": [{ "text": "caption", "startTime": 0, "duration": 4004 }]
                },
                {
                    "kind": "upsert_effect",
                    "trackId": "track-main",
                    "elementId": "video-1",
                    "effectId": "effect-live",
                    "effectType": "blur",
                    "enabled": true
                }
            ],
            "before": before
        }))
        .expect("valid live-shaped evaluation request");

        let mut result = evaluate(request).expect("validated live-shaped plan");
        result.before.media_assets[0].role = None;
        result.predicted_after.media_assets[0].role = None;
        let response = EditPlanEvaluationResponse::Validated {
            result: Box::new(result),
        };
        let js_response = response.into_js().expect("response converts to JS");

        assert_no_undefined(&js_response, "$".into());
        let json = JSON::stringify(&js_response)
            .expect("response JSON stringifies")
            .as_string()
            .expect("JSON text");
        assert!(json.contains("\"role\":null"));
        assert!(json.contains("\"style\":null"));
        assert!(json.contains("\"crop\":null"));
        let round_trip = JSON::parse(&json).expect("response JSON parses");
        assert_no_undefined(&round_trip, "$".into());
    }

    fn assert_no_undefined(value: &JsValue, path: String) {
        assert!(!value.is_undefined(), "undefined at {path}");
        if value.is_null() || !value.is_object() {
            return;
        }
        if Array::is_array(value) {
            let array = Array::from(value);
            for index in 0..array.length() {
                assert_no_undefined(&array.get(index), format!("{path}[{index}]"));
            }
            return;
        }
        let object = Object::from(value.clone());
        for key in Object::keys(&object) {
            let key = key.as_string().expect("object string key");
            let child = Reflect::get(&object, &JsValue::from_str(&key)).expect("object field");
            assert_no_undefined(&child, format!("{path}.{key}"));
        }
    }
}

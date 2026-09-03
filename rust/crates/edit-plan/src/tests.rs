use std::collections::BTreeMap;

use super::*;
use time::{FrameRate, MediaTime};

fn canonical_settings() -> CanonicalObject {
    BTreeMap::from([
        (
            "background".into(),
            CanonicalValue::Object(BTreeMap::from([
                ("color".into(), CanonicalValue::String("#000000".into())),
                ("type".into(), CanonicalValue::String("color".into())),
            ])),
        ),
        (
            "canvasSize".into(),
            CanonicalValue::Object(BTreeMap::from([
                ("height".into(), CanonicalValue::Unsigned(1920)),
                ("width".into(), CanonicalValue::Unsigned(1080)),
            ])),
        ),
        (
            "fps".into(),
            CanonicalValue::Object(BTreeMap::from([
                ("denominator".into(), CanonicalValue::Unsigned(1)),
                ("numerator".into(), CanonicalValue::Unsigned(30)),
            ])),
        ),
    ])
}

fn empty_track(id: &str, role: &str, kind: &str, order: usize) -> CanonicalTrack {
    CanonicalTrack {
        role: role.into(),
        order,
        id: id.into(),
        name: format!("{kind} track"),
        track_type: kind.into(),
        muted: Some(false),
        hidden: Some(false),
        transitions: vec![],
        elements: vec![],
    }
}

fn snapshot() -> ProjectSnapshot {
    ProjectSnapshot {
        projection: PROJECT_CONTENT_PROJECTION.into(),
        projection_version: PROJECT_CONTENT_PROJECTION_VERSION,
        project: CanonicalProject {
            id: None,
            name: "Project".into(),
            active_scene_id: "scene".into(),
            main_scene_id: Some("scene".into()),
            settings: canonical_settings(),
            scenes: vec![
                CanonicalScene {
                    order: 0,
                    id: "scene".into(),
                    name: "Scene".into(),
                    is_main: true,
                    bookmarks: vec![],
                    tracks: vec![empty_track("main", "main", "video", 0)],
                },
                CanonicalScene {
                    order: 1,
                    id: "untouched".into(),
                    name: "Untouched".into(),
                    is_main: false,
                    bookmarks: vec![CanonicalBookmark {
                        order: 0,
                        time: MediaTime::from_ticks(4_000),
                        duration: None,
                        note: Some("keep".into()),
                        color: None,
                    }],
                    tracks: vec![empty_track("untouched-main", "main", "video", 0)],
                },
            ],
        },
        media_assets: vec![CanonicalMediaAsset {
            id: "asset".into(),
            name: "asset.png".into(),
            asset_type: "image".into(),
            size: Some(42),
            width: Some(2),
            height: Some(2),
            duration: None,
            fps: None,
            has_audio: None,
            source_fingerprint: Some("fixture".into()),
            source: CanonicalMediaSource::Local {
                content_hash: Some(ImmutableHash {
                    algorithm: "SHA-256".into(),
                    digest: "a".repeat(64),
                }),
            },
            role: Some("timeline".into()),
        }],
    }
}

fn options(operations: Vec<EditOperation>) -> EvaluateEditPlanOptions {
    options_with_before(snapshot(), operations)
}

fn resolved_caption(text: &str, start_time: MediaTime, duration: MediaTime) -> Caption {
    let params = default_text_params(text);
    Caption {
        element_id: None,
        text: text.into(),
        start_time,
        duration,
        resolved_name: Some("Caption 1".into()),
        resolved_content: Some(text.into()),
        resolved_params: Some(CanonicalValue::Object(
            params
                .into_iter()
                .map(|(key, value)| {
                    let value = match value {
                        Scalar::String(value) => CanonicalValue::String(value),
                        Scalar::Number(value) => CanonicalValue::Number(value),
                        Scalar::Boolean(value) => CanonicalValue::Boolean(value),
                    };
                    (key, value)
                })
                .collect(),
        )),
        resolved_layout_version: Some("opencut.caption-layout.v1".into()),
        resolved_layout_engine: Some("browser-canvas-2d".into()),
    }
}

fn options_with_before(
    before: ProjectSnapshot,
    operations: Vec<EditOperation>,
) -> EvaluateEditPlanOptions {
    let scene_id = before.project.active_scene_id.clone();
    EvaluateEditPlanOptions {
        contract_version: CONTRACT_VERSION.into(),
        source: SourceBinding {
            connection_identity: ConnectionIdentity {
                server_instance_id: "server".into(),
                editor_instance_id: "editor".into(),
                editor_session_id: "session".into(),
                connection_generation: 1,
                bridge_protocol_version: 2,
            },
            project_id: "project".into(),
            scene_id,
            session_revision: 2,
            canonical_project_hash: hash_serialized(&before).unwrap(),
            durable_write_version: 3,
            save_receipt_id: "receipt".into(),
            save_operation_id: "save".into(),
        },
        capability_snapshot: CapabilitySnapshot {
            hash: "b".repeat(64),
            edit_plan_ready: true,
            provider_execution: ProviderExecution::Forbidden,
            cost: Cost::NotApplicable,
        },
        policy: Policy {
            warning_policy: WarningPolicy::Allow,
            provider_execution: ProviderExecution::Forbidden,
            cost_policy: CostPolicy::RequireExact,
        },
        description: "test plan".into(),
        operations,
        before,
    }
}

fn full_snapshot() -> ProjectSnapshot {
    serde_json::from_str(include_str!(
        "../tests/fixtures/full-project-content-v1.json"
    ))
    .unwrap()
}

#[test]
fn sequential_created_track_is_visible_to_later_insert() {
    let result = evaluate(options(vec![
        EditOperation::AddTrack {
            track_type: TrackType::Graphic,
            track_id: "graphics".into(),
        },
        EditOperation::InsertGraphic {
            element_id: None,
            definition_id: "rectangle".into(),
            name: None,
            start_time: MediaTime::ZERO,
            duration: MediaTime::from_ticks(120_000),
            track_id: Some("graphics".into()),
            params: None,
            auto_track_id: None,
            resolved_allocations: None,
        },
    ]))
    .unwrap();
    let scene = &result.predicted_after.project.scenes[0];
    assert_eq!(scene.tracks.len(), 2);
    let graphics = scene
        .tracks
        .iter()
        .find(|track| track.id == "graphics")
        .expect("created graphics track");
    assert!(graphics.elements[0].common().id.starts_with("plan-"));
}

#[test]
fn insert_variants_allocate_auto_tracks_only_when_first_available_requires_one() {
    let variants = vec![
        (
            "text",
            EditOperation::InsertText {
                element_id: None,
                content: "text".into(),
                start_time: MediaTime::ZERO,
                duration: MediaTime::from_ticks(10_000),
                auto_track_id: None,
                resolved_allocations: None,
            },
        ),
        (
            "graphic",
            EditOperation::InsertGraphic {
                element_id: None,
                definition_id: "rectangle".into(),
                name: None,
                start_time: MediaTime::ZERO,
                duration: MediaTime::from_ticks(10_000),
                track_id: None,
                params: None,
                auto_track_id: None,
                resolved_allocations: None,
            },
        ),
        (
            "graphic",
            EditOperation::InsertSticker {
                element_id: None,
                sticker_id: "shapes:star".into(),
                name: None,
                start_time: MediaTime::ZERO,
                duration: MediaTime::from_ticks(10_000),
                track_id: None,
                params: None,
                auto_track_id: None,
                resolved_allocations: None,
            },
        ),
        (
            "effect",
            EditOperation::InsertAdjustmentLayer {
                element_id: None,
                effect_type: "blur".into(),
                name: None,
                start_time: MediaTime::ZERO,
                duration: MediaTime::from_ticks(10_000),
                track_id: None,
                params: None,
                auto_track_id: None,
                resolved_allocations: None,
            },
        ),
    ];
    for (expected_track_type, operation) in variants {
        let result = evaluate(options(vec![operation])).unwrap();
        let (element_id, auto_track_id, allocations) = match &result.resolved_operations[0] {
            EditOperation::InsertText {
                element_id: Some(element_id),
                auto_track_id: Some(auto_track_id),
                resolved_allocations: Some(allocations),
                ..
            }
            | EditOperation::InsertGraphic {
                element_id: Some(element_id),
                auto_track_id: Some(auto_track_id),
                resolved_allocations: Some(allocations),
                ..
            }
            | EditOperation::InsertSticker {
                element_id: Some(element_id),
                auto_track_id: Some(auto_track_id),
                resolved_allocations: Some(allocations),
                ..
            }
            | EditOperation::InsertAdjustmentLayer {
                element_id: Some(element_id),
                auto_track_id: Some(auto_track_id),
                resolved_allocations: Some(allocations),
                ..
            } => (element_id, auto_track_id, allocations),
            _ => panic!("insert operation did not resolve its automatic track"),
        };
        assert_eq!(allocations.len(), 1);
        assert_eq!(allocations[0].role, AllocationRole::ElementAutoTrack);
        assert_eq!(allocations[0].source_id, *element_id);
        assert_eq!(allocations[0].resolved_id, *auto_track_id);
        let predicted_track = result.predicted_after.project.scenes[0]
            .tracks
            .iter()
            .find(|track| track.id == *auto_track_id)
            .expect("allocated track must be present");
        assert_eq!(predicted_track.track_type, expected_track_type);
    }

    let result = evaluate(options(vec![
        EditOperation::InsertText {
            element_id: None,
            content: "first".into(),
            start_time: MediaTime::ZERO,
            duration: MediaTime::from_ticks(10_000),
            auto_track_id: None,
            resolved_allocations: None,
        },
        EditOperation::InsertText {
            element_id: None,
            content: "second".into(),
            start_time: MediaTime::from_ticks(10_000),
            duration: MediaTime::from_ticks(10_000),
            auto_track_id: None,
            resolved_allocations: None,
        },
    ]))
    .unwrap();
    let EditOperation::InsertText {
        auto_track_id: None,
        resolved_allocations: Some(second_allocations),
        ..
    } = &result.resolved_operations[1]
    else {
        panic!("non-overlapping text did not reuse the first available text track");
    };
    assert!(second_allocations.is_empty());
}

#[test]
fn real_preflight_reframe_captions_effect_sequence_completes_synchronously() {
    let started = std::time::Instant::now();
    let result = evaluate(options_with_before(
        full_snapshot(),
        vec![
            EditOperation::SetReframe {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                mode: Some(ReframeMode::Fit),
                crop: None,
                focal_point: None,
                target_rect: None,
                layout: None,
            },
            EditOperation::InsertCaptions {
                track_id: None,
                captions: vec![resolved_caption(
                    "caption",
                    MediaTime::ZERO,
                    MediaTime::from_ticks(30_000),
                )],
                style: None,
            },
            EditOperation::UpsertEffect {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                effect_id: "effect-e2e".into(),
                effect_type: "blur".into(),
                params: Some(Params(BTreeMap::from([(
                    "intensity".into(),
                    Scalar::Number(15.0),
                )]))),
                enabled: Some(true),
            },
        ],
    ))
    .unwrap();
    assert_eq!(result.resolved_operations.len(), 3);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
}

#[test]
fn hashes_and_allocated_ids_are_deterministic() {
    let operation = EditOperation::InsertText {
        element_id: None,
        content: "Hello".into(),
        start_time: MediaTime::ZERO,
        duration: MediaTime::from_ticks(60_000),
        auto_track_id: None,
        resolved_allocations: None,
    };
    let first = evaluate(options(vec![operation.clone()])).unwrap();
    let second = evaluate(options(vec![operation])).unwrap();
    assert_eq!(first.plan_fingerprint, second.plan_fingerprint);
    assert_eq!(first.preflight_fingerprint, second.preflight_fingerprint);
    assert_eq!(first.plan_diff_hash, second.plan_diff_hash);
    assert_eq!(first.predicted_project_hash, second.predicted_project_hash);
}

#[test]
fn untouched_scene_and_media_are_preserved() {
    let before = snapshot();
    let result = evaluate(options(vec![EditOperation::InsertText {
        element_id: None,
        content: "Hello".into(),
        start_time: MediaTime::ZERO,
        duration: MediaTime::from_ticks(60_000),
        auto_track_id: None,
        resolved_allocations: None,
    }]))
    .unwrap();
    assert_eq!(
        result.predicted_after.project.scenes[1],
        before.project.scenes[1]
    );
    assert_eq!(result.predicted_after.media_assets, before.media_assets);
}

#[test]
fn source_hash_mismatch_fails_closed() {
    let mut request = options(vec![EditOperation::InsertText {
        element_id: None,
        content: "Hello".into(),
        start_time: MediaTime::ZERO,
        duration: MediaTime::from_ticks(60_000),
        auto_track_id: None,
        resolved_allocations: None,
    }]);
    request.source.canonical_project_hash = "c".repeat(64);
    assert!(matches!(
        evaluate(request).unwrap_err().code,
        ErrorCode::SourceMismatch
    ));
}

#[test]
fn unsupported_fps_fails_closed() {
    let mut request = options(vec![EditOperation::SetProjectSettings {
        fps: Some(FrameRate::new(7, 3)),
        canvas_size: None,
        background: None,
    }]);
    request.before.project.settings.insert(
        "fps".into(),
        CanonicalValue::Object(BTreeMap::from([
            ("numerator".into(), CanonicalValue::Unsigned(7)),
            ("denominator".into(), CanonicalValue::Unsigned(3)),
        ])),
    );
    request.source.canonical_project_hash = hash_serialized(&request.before).unwrap();
    assert!(matches!(
        evaluate(request).unwrap_err().code,
        ErrorCode::UnsupportedFrameRate
    ));
}

#[test]
fn response_is_a_typed_error_union() {
    let mut request = options(vec![]);
    request.contract_version = "wrong".into();
    assert!(matches!(
        evaluate_edit_plan(request),
        EditPlanEvaluationResponse::Rejected {
            error: EditPlanError {
                code: ErrorCode::ContractVersion,
                ..
            }
        }
    ));
}

#[test]
fn project_content_v2_binds_the_project_identity() {
    let mut before = snapshot();
    before.projection_version = CURRENT_PROJECT_CONTENT_PROJECTION_VERSION;
    before.project.id = Some("another-project".into());
    let request = options_with_before(
        before,
        vec![EditOperation::SetTrackState {
            track_id: "main".into(),
            muted: Some(true),
            hidden: None,
        }],
    );
    assert!(matches!(
        evaluate(request).unwrap_err().code,
        ErrorCode::SourceMismatch
    ));
}

#[test]
fn full_projection_matches_web_canonical_hash_golden() {
    let raw: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/full-project-content-v1.json"
    ))
    .unwrap();
    let fixture: ProjectSnapshot = serde_json::from_str(include_str!(
        "../tests/fixtures/full-project-content-v1.json"
    ))
    .unwrap();
    let raw_serialized = canonical_json(&raw).unwrap();
    let typed_serialized = canonical_json(&serde_json::to_value(&fixture).unwrap()).unwrap();
    if raw_serialized != typed_serialized {
        let index = raw_serialized
            .bytes()
            .zip(typed_serialized.bytes())
            .position(|(left, right)| left != right)
            .unwrap_or(raw_serialized.len().min(typed_serialized.len()));
        let start = index.saturating_sub(80);
        let raw_end = (index + 160).min(raw_serialized.len());
        let typed_end = (index + 160).min(typed_serialized.len());
        panic!(
            "typed projection changed canonical bytes at {index}\nraw: {}\ntyped: {}",
            &raw_serialized[start..raw_end],
            &typed_serialized[start..typed_end]
        );
    }
    assert_eq!(
        hash_serialized(&fixture).unwrap(),
        "3925eec0bcfda9c81c325e8436b3744f0794875189f8a508bf3d51f802a5424c"
    );
}

#[test]
fn canonical_hash_distinguishes_null_from_omitted_and_normalizes_negative_zero() {
    let explicit_null = serde_json::json!({ "value": null });
    let omitted = serde_json::json!({});
    assert_ne!(
        hash_serialized(&explicit_null).unwrap(),
        hash_serialized(&omitted).unwrap()
    );
    assert_eq!(
        canonical_json(&serde_json::json!(-0.0)).unwrap(),
        canonical_json(&serde_json::json!(0.0)).unwrap()
    );
}

#[test]
fn canonical_number_format_matches_ecmascript_json_stringify() {
    let cases = [
        (2.0, "2"),
        (30.0, "30"),
        (1.0e-7, "1e-7"),
        (1.0e-6, "0.000001"),
        (1.0e-5, "0.00001"),
        (1.0e20, "100000000000000000000"),
        (1.0e21, "1e+21"),
        (1.234_567_890_123_456_7, "1.2345678901234567"),
        (1_000_000_000_000_000_100.0, "1000000000000000100"),
        (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
        (f64::from_bits(1), "5e-324"),
    ];
    for (value, expected) in cases {
        let actual = canonical_json(&serde_json::json!(value)).unwrap();
        assert_eq!(actual, expected, "canonical number mismatch for {value:?}");
    }
}

#[test]
fn canonical_object_keys_follow_ecmascript_utf16_sort_order() {
    let value = serde_json::json!({
        "\u{e000}": 2,
        "\u{10000}": 1,
    });
    assert_eq!(canonical_json(&value).unwrap(), "{\"𐀀\":1,\"\":2}");
}

#[test]
fn integral_media_floats_match_web_projection_bytes_and_hash() {
    let mut raw: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/full-project-content-v1.json"
    ))
    .unwrap();
    let media = raw["mediaAssets"]
        .as_array_mut()
        .and_then(|assets| assets.first_mut())
        .expect("fixture media asset");
    media["duration"] = serde_json::json!(2);
    media["fps"] = serde_json::json!(30);

    let typed: ProjectSnapshot = serde_json::from_value(raw.clone()).unwrap();
    let raw_serialized = canonical_json(&raw).unwrap();
    let typed_serialized = canonical_json(&serde_json::to_value(&typed).unwrap()).unwrap();

    assert_eq!(typed_serialized, raw_serialized);
    assert_eq!(
        hash_serialized(&typed).unwrap(),
        "2cfb90dd5859074bde54e9f59bdbae225e4172616cd867d2dea450a5b86ce83a"
    );
}

#[test]
fn adjust_mix_gain_matches_audible_filter_keyframes_and_common_bounds() {
    let mut before = full_snapshot();
    let main_track = &mut before.project.scenes[0].tracks[0];
    let video = main_track
        .elements
        .iter_mut()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    video.common_mut().params = CanonicalValue::Object(BTreeMap::from([
        ("muted".into(), CanonicalValue::Boolean(false)),
        ("volume".into(), CanonicalValue::Number(5.0)),
    ]));
    video.common_mut().animations = CanonicalValue::Object(BTreeMap::from([(
        "volume".into(),
        CanonicalValue::Object(BTreeMap::from([(
            "keys".into(),
            CanonicalValue::Array(vec![
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("volume-1".into())),
                    ("time".into(), CanonicalValue::Integer(0)),
                    ("value".into(), CanonicalValue::Number(-10.0)),
                    (
                        "segmentToNext".into(),
                        CanonicalValue::String("linear".into()),
                    ),
                ])),
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("volume-2".into())),
                    ("time".into(), CanonicalValue::Integer(120_120)),
                    ("value".into(), CanonicalValue::Number(10.0)),
                    (
                        "segmentToNext".into(),
                        CanonicalValue::String("linear".into()),
                    ),
                ])),
            ]),
        )])),
    )]));
    let audio_track = before.project.scenes[0]
        .tracks
        .iter_mut()
        .find(|track| track.id == "track-audio")
        .unwrap();
    audio_track.muted = Some(true);
    let unchanged_audio = audio_track.elements[0].common().params.clone();

    let result = evaluate(options_with_before(
        before.clone(),
        vec![EditOperation::AdjustMixGain { gain_db: 5.0 }],
    ))
    .unwrap();
    let scene = &result.predicted_after.project.scenes[0];
    let shifted_video = scene.tracks[0]
        .elements
        .iter()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    let CanonicalValue::Object(params) = &shifted_video.common().params else {
        panic!("video params changed shape");
    };
    assert_eq!(params["volume"], CanonicalValue::Number(10.0));
    let CanonicalValue::Object(animations) = &shifted_video.common().animations else {
        panic!("video animations changed shape");
    };
    let CanonicalValue::Object(volume) = &animations["volume"] else {
        panic!("volume channel changed shape");
    };
    let CanonicalValue::Array(keys) = &volume["keys"] else {
        panic!("volume keys changed shape");
    };
    let values: Vec<_> = keys
        .iter()
        .map(|key| {
            let CanonicalValue::Object(key) = key else {
                panic!("volume key changed shape");
            };
            key["value"].clone()
        })
        .collect();
    assert_eq!(
        values,
        vec![CanonicalValue::Number(-5.0), CanonicalValue::Number(15.0)]
    );
    let predicted_audio = scene
        .tracks
        .iter()
        .find(|track| track.id == "track-audio")
        .unwrap();
    assert_eq!(predicted_audio.elements[0].common().params, unchanged_audio);

    let out_of_range = evaluate(options_with_before(
        before,
        vec![EditOperation::AdjustMixGain { gain_db: 10.1 }],
    ))
    .unwrap_err();
    assert!(matches!(out_of_range.code, ErrorCode::Bounds));
    assert_eq!(out_of_range.path.as_deref(), Some("gainDb"));
}

#[test]
fn adjust_mix_gain_rejects_projects_without_audible_timeline_elements() {
    let mut before = full_snapshot();
    for track in &mut before.project.scenes[0].tracks {
        if matches!(track.track_type.as_str(), "audio" | "video") {
            track.muted = Some(true);
        }
    }
    let error = evaluate(options_with_before(
        before,
        vec![EditOperation::AdjustMixGain { gain_db: 1.0 }],
    ))
    .unwrap_err();
    assert!(matches!(error.code, ErrorCode::InvalidValue));
    assert!(error.message.contains("no audible"));
}

#[test]
fn all_41_operation_variants_have_a_strict_typed_transport_shape() {
    let reference = serde_json::json!({ "trackId": "main", "elementId": "element" });
    let operations = vec![
        serde_json::json!({ "kind": "insert_text", "content": "x", "startTime": 0, "duration": 1 }),
        serde_json::json!({ "kind": "insert_graphic", "definitionId": "g", "startTime": 0, "duration": 1 }),
        serde_json::json!({ "kind": "insert_sticker", "stickerId": "s", "startTime": 0, "duration": 1 }),
        serde_json::json!({ "kind": "insert_adjustment_layer", "effectType": "e", "startTime": 0, "duration": 1 }),
        serde_json::json!({ "kind": "add_track", "trackType": "video", "trackId": "t" }),
        serde_json::json!({ "kind": "set_track_state", "trackId": "t", "muted": true }),
        serde_json::json!({ "kind": "set_project_settings", "fps": { "numerator": 30, "denominator": 1 } }),
        serde_json::json!({ "kind": "insert_captions", "captions": [{ "text": "x", "startTime": 0, "duration": 1 }] }),
        serde_json::json!({ "kind": "update_caption", "trackId": "t", "elementId": "e", "text": "x" }),
        serde_json::json!({ "kind": "delete", "trackId": "t", "elementId": "e", "ripple": false, "relationshipScope": "all" }),
        serde_json::json!({ "kind": "duplicate_elements", "elements": [reference.clone()], "relationshipScope": "all" }),
        serde_json::json!({ "kind": "create_compound", "compoundId": "c", "elements": [reference.clone(), reference.clone()], "relationshipScope": "all" }),
        serde_json::json!({ "kind": "break_apart_compound", "trackId": "t", "elementId": "e" }),
        serde_json::json!({ "kind": "set_group", "groupId": "g", "elements": [reference.clone(), reference.clone()] }),
        serde_json::json!({ "kind": "clear_group", "groupId": "g" }),
        serde_json::json!({ "kind": "set_link", "linkId": "l", "elements": [reference.clone(), reference.clone()] }),
        serde_json::json!({ "kind": "clear_link", "linkId": "l" }),
        serde_json::json!({ "kind": "move", "trackId": "t", "elementId": "e", "startTime": 0, "relationshipScope": "all" }),
        serde_json::json!({ "kind": "set_params", "trackId": "t", "elementId": "e", "params": { "x": 1 } }),
        serde_json::json!({ "kind": "set_reframe", "trackId": "t", "elementId": "e", "mode": "fit" }),
        serde_json::json!({ "kind": "set_audio", "trackId": "t", "elementId": "e", "muted": true }),
        serde_json::json!({ "kind": "separate_source_audio", "trackId": "t", "elementId": "e" }),
        serde_json::json!({ "kind": "duck_audio", "trackId": "t", "elementId": "e", "regions": [], "reductionDb": -6, "attackDuration": 0, "releaseDuration": 0 }),
        serde_json::json!({ "kind": "adjust_mix_gain", "gainDb": 1 }),
        serde_json::json!({ "kind": "upsert_effect", "trackId": "t", "elementId": "e", "effectId": "fx", "effectType": "blur" }),
        serde_json::json!({ "kind": "remove_effect", "trackId": "t", "elementId": "e", "effectId": "fx" }),
        serde_json::json!({ "kind": "reorder_effects", "trackId": "t", "elementId": "e", "effectIds": ["fx"] }),
        serde_json::json!({ "kind": "upsert_keyframe", "trackId": "t", "elementId": "e", "propertyPath": "opacity", "time": 0, "value": 1 }),
        serde_json::json!({ "kind": "remove_keyframe", "trackId": "t", "elementId": "e", "propertyPath": "opacity", "keyframeId": "k" }),
        serde_json::json!({ "kind": "retime_keyframe", "trackId": "t", "elementId": "e", "propertyPath": "opacity", "keyframeId": "k", "time": 1 }),
        serde_json::json!({ "kind": "upsert_transition", "trackId": "t", "transitionId": "tr", "fromElementId": "a", "toElementId": "b", "transitionType": "crossfade", "duration": 1 }),
        serde_json::json!({ "kind": "remove_transition", "trackId": "t", "transitionId": "tr" }),
        serde_json::json!({ "kind": "set_retime", "trackId": "t", "elementId": "e", "rate": 1.25 }),
        serde_json::json!({ "kind": "trim", "trackId": "t", "elementId": "e", "trimStart": 0, "trimEnd": 0, "ripple": false }),
        serde_json::json!({ "kind": "split", "trackId": "t", "elementId": "e", "splitTime": 1, "ripple": false }),
        serde_json::json!({ "kind": "set_matte_state", "trackId": "t", "elementId": "e", "enabled": true }),
        serde_json::json!({ "kind": "remove_matte", "trackId": "t", "elementId": "e" }),
        serde_json::json!({ "kind": "set_mask", "trackId": "t", "elementId": "e", "maskId": "m", "maskType": "freeform", "params": { "path": [{ "id": "p", "x": 0.1, "y": 0.2, "inX": 0.0, "inY": 0.0, "outX": 0.3, "outY": 0.4 }] } }),
        serde_json::json!({ "kind": "remove_mask", "trackId": "t", "elementId": "e", "maskId": "m" }),
        serde_json::json!({ "kind": "set_audio_replacement_state", "trackId": "t", "elementId": "e", "enabled": true }),
        serde_json::json!({ "kind": "remove_audio_replacement", "trackId": "t", "elementId": "e" }),
    ];
    assert_eq!(operations.len(), 41);
    for operation in operations {
        let expected_kind = operation["kind"].clone();
        let typed: EditOperation = serde_json::from_value(operation.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap()["kind"], expected_kind);
    }
}

#[test]
fn all_41_operation_variants_have_valid_and_invalid_evaluator_coverage() {
    let t = MediaTime::from_ticks;
    let reference = || ElementRef {
        track_id: "track-text".into(),
        element_id: "text-1".into(),
    };
    let mut reorder_snapshot = full_snapshot();
    let CanonicalElement::Video { effects, .. } =
        &mut reorder_snapshot.project.scenes[0].tracks[0].elements[0]
    else {
        panic!("fixture video changed type");
    };
    effects.push(CanonicalEffect {
        order: 1,
        id: "effect-2".into(),
        effect_type: "blur".into(),
        enabled: true,
        params: CanonicalValue::Object(BTreeMap::from([(
            "intensity".into(),
            CanonicalValue::Number(15.0),
        )])),
    });
    let mut transition_snapshot = full_snapshot();
    let transition_track = &mut transition_snapshot.project.scenes[0].tracks[0];
    let mut second_video = transition_track.elements[0].clone();
    second_video.common_mut().id = "video-2".into();
    second_video.common_mut().name = "Second video".into();
    second_video.common_mut().order = 1;
    second_video.common_mut().start_time = t(120_120);
    second_video.common_mut().duration = t(60_060);
    second_video.common_mut().source_duration = Some(t(60_060));
    transition_track.elements[1] = second_video;
    transition_track.transitions.clear();
    let cases: Vec<(&str, ProjectSnapshot, Vec<EditOperation>)> = vec![
        (
            "insert_text",
            full_snapshot(),
            vec![EditOperation::InsertText {
                element_id: None,
                content: "new".into(),
                start_time: t(200_000),
                duration: t(10_000),
                auto_track_id: None,
                resolved_allocations: None,
            }],
        ),
        (
            "insert_graphic",
            full_snapshot(),
            vec![EditOperation::InsertGraphic {
                element_id: None,
                definition_id: "rectangle".into(),
                name: None,
                start_time: t(10_000),
                duration: t(10_000),
                track_id: None,
                params: None,
                auto_track_id: None,
                resolved_allocations: None,
            }],
        ),
        (
            "insert_sticker",
            full_snapshot(),
            vec![EditOperation::InsertSticker {
                element_id: None,
                sticker_id: "flags:US".into(),
                name: None,
                start_time: t(10_000),
                duration: t(10_000),
                track_id: None,
                params: None,
                auto_track_id: None,
                resolved_allocations: None,
            }],
        ),
        (
            "insert_adjustment_layer",
            full_snapshot(),
            vec![EditOperation::InsertAdjustmentLayer {
                element_id: None,
                effect_type: "blur".into(),
                name: None,
                start_time: t(200_000),
                duration: t(10_000),
                track_id: None,
                params: None,
                auto_track_id: None,
                resolved_allocations: None,
            }],
        ),
        (
            "add_track",
            full_snapshot(),
            vec![
                EditOperation::AddTrack {
                    track_type: TrackType::Graphic,
                    track_id: "new-track".into(),
                },
                EditOperation::InsertGraphic {
                    element_id: None,
                    definition_id: "ellipse".into(),
                    name: None,
                    start_time: t(20_000),
                    duration: t(10_000),
                    track_id: Some("new-track".into()),
                    params: None,
                    auto_track_id: None,
                    resolved_allocations: None,
                },
            ],
        ),
        (
            "set_track_state",
            full_snapshot(),
            vec![EditOperation::SetTrackState {
                track_id: "track-main".into(),
                muted: Some(true),
                hidden: None,
            }],
        ),
        (
            "set_project_settings",
            full_snapshot(),
            vec![EditOperation::SetProjectSettings {
                fps: Some(FrameRate::new(24, 1)),
                canvas_size: None,
                background: None,
            }],
        ),
        (
            "insert_captions",
            full_snapshot(),
            vec![EditOperation::InsertCaptions {
                track_id: None,
                captions: vec![resolved_caption("new caption", t(10_000), t(20_000))],
                style: None,
            }],
        ),
        (
            "update_caption",
            full_snapshot(),
            vec![EditOperation::UpdateCaption {
                track_id: "track-text".into(),
                element_id: "text-1".into(),
                text: Some("corrected".into()),
                start_time: None,
                duration: None,
                resolved_allocations: None,
            }],
        ),
        (
            "delete",
            full_snapshot(),
            vec![EditOperation::Delete {
                track_id: "track-text".into(),
                element_id: "text-1".into(),
                ripple: false,
                relationship_scope: RelationshipScope::Element,
            }],
        ),
        (
            "duplicate_elements",
            full_snapshot(),
            vec![EditOperation::DuplicateElements {
                elements: vec![reference()],
                duplicate_ids: None,
                relationship_scope: RelationshipScope::Element,
                resolved_allocations: None,
            }],
        ),
        (
            "create_compound",
            full_snapshot(),
            vec![EditOperation::CreateCompound {
                compound_id: "compound-new".into(),
                name: None,
                elements: vec![
                    ElementRef {
                        track_id: "track-main".into(),
                        element_id: "video-1".into(),
                    },
                    reference(),
                ],
                relationship_scope: RelationshipScope::Element,
                target_track_id: None,
                auto_track_id: None,
                empty_main_track_id: None,
                resolved_allocations: None,
            }],
        ),
        (
            "break_apart_compound",
            full_snapshot(),
            vec![EditOperation::BreakApartCompound {
                track_id: "track-main".into(),
                element_id: "compound-1".into(),
                restored_element_ids: None,
                resolved_allocations: None,
            }],
        ),
        (
            "set_group",
            full_snapshot(),
            vec![EditOperation::SetGroup {
                group_id: "group-new".into(),
                elements: vec![
                    ElementRef {
                        track_id: "track-main".into(),
                        element_id: "video-1".into(),
                    },
                    reference(),
                ],
            }],
        ),
        (
            "clear_group",
            full_snapshot(),
            vec![EditOperation::ClearGroup {
                group_id: "group-1".into(),
            }],
        ),
        (
            "set_link",
            full_snapshot(),
            vec![EditOperation::SetLink {
                link_id: "link-new".into(),
                elements: vec![
                    ElementRef {
                        track_id: "track-main".into(),
                        element_id: "video-1".into(),
                    },
                    reference(),
                ],
            }],
        ),
        (
            "clear_link",
            full_snapshot(),
            vec![EditOperation::ClearLink {
                link_id: "link-1".into(),
            }],
        ),
        (
            "move",
            full_snapshot(),
            vec![EditOperation::Move {
                track_id: "track-text".into(),
                target_track_id: None,
                element_id: "text-1".into(),
                start_time: t(1_000),
                relationship_scope: RelationshipScope::Element,
            }],
        ),
        (
            "set_params",
            full_snapshot(),
            vec![EditOperation::SetParams {
                track_id: "track-text".into(),
                element_id: "text-1".into(),
                params: Params::from_iter([("content".into(), Scalar::String("changed".into()))]),
            }],
        ),
        (
            "set_reframe",
            full_snapshot(),
            vec![EditOperation::SetReframe {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                mode: Some(ReframeMode::Cover),
                crop: None,
                focal_point: None,
                target_rect: None,
                layout: None,
            }],
        ),
        (
            "set_audio",
            full_snapshot(),
            vec![EditOperation::SetAudio {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                volume_db: Some(-6.0),
                muted: None,
                fade: None,
                resolved_allocations: None,
            }],
        ),
        (
            "separate_source_audio",
            full_snapshot(),
            vec![EditOperation::SeparateSourceAudio {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                audio_track_id: None,
                audio_element_id: None,
                link_id: None,
                resolved_allocations: None,
            }],
        ),
        (
            "duck_audio",
            full_snapshot(),
            vec![EditOperation::DuckAudio {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                regions: vec![Region {
                    start_time: t(10_000),
                    duration: t(10_000),
                }],
                reduction_db: 6.0,
                attack_duration: t(1_000),
                release_duration: t(1_000),
                resolved_allocations: None,
            }],
        ),
        (
            "adjust_mix_gain",
            full_snapshot(),
            vec![EditOperation::AdjustMixGain { gain_db: 1.0 }],
        ),
        (
            "upsert_effect",
            full_snapshot(),
            vec![EditOperation::UpsertEffect {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                effect_id: "effect-new".into(),
                effect_type: "blur".into(),
                params: None,
                enabled: None,
            }],
        ),
        (
            "remove_effect",
            full_snapshot(),
            vec![EditOperation::RemoveEffect {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                effect_id: "effect-1".into(),
            }],
        ),
        (
            "reorder_effects",
            reorder_snapshot,
            vec![EditOperation::ReorderEffects {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                effect_ids: vec!["effect-2".into(), "effect-1".into()],
            }],
        ),
        (
            "upsert_keyframe",
            full_snapshot(),
            vec![EditOperation::UpsertKeyframe {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                property_path: "opacity".into(),
                time: t(60_000),
                value: Scalar::Number(0.5),
                interpolation: None,
                keyframe_id: None,
            }],
        ),
        (
            "remove_keyframe",
            full_snapshot(),
            vec![EditOperation::RemoveKeyframe {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                property_path: "opacity".into(),
                keyframe_id: "keyframe-1".into(),
            }],
        ),
        (
            "retime_keyframe",
            full_snapshot(),
            vec![EditOperation::RetimeKeyframe {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                property_path: "opacity".into(),
                keyframe_id: "keyframe-1".into(),
                time: t(1_000),
            }],
        ),
        (
            "upsert_transition",
            transition_snapshot,
            vec![EditOperation::UpsertTransition {
                track_id: "track-main".into(),
                transition_id: "transition-new".into(),
                from_element_id: "video-1".into(),
                to_element_id: "video-2".into(),
                transition_type: TransitionType::Slide,
                duration: t(4_000),
            }],
        ),
        (
            "remove_transition",
            full_snapshot(),
            vec![EditOperation::RemoveTransition {
                track_id: "track-main".into(),
                transition_id: "transition-1".into(),
            }],
        ),
        (
            "set_retime",
            full_snapshot(),
            vec![EditOperation::SetRetime {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                rate: 2.0,
                maintain_pitch: None,
                resolved_allocations: None,
            }],
        ),
        (
            "trim",
            full_snapshot(),
            vec![EditOperation::Trim {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                start_time: None,
                duration: Some(t(119_120)),
                trim_start: t(1_000),
                trim_end: t(0),
                ripple: false,
                resolved_allocations: None,
            }],
        ),
        (
            "split",
            full_snapshot(),
            vec![EditOperation::Split {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                split_time: t(60_000),
                right_element_id: None,
                retain_side: None,
                ripple: false,
                resolved_allocations: None,
            }],
        ),
        (
            "set_matte_state",
            full_snapshot(),
            vec![EditOperation::SetMatteState {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                enabled: false,
            }],
        ),
        (
            "remove_matte",
            full_snapshot(),
            vec![EditOperation::RemoveMatte {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
            }],
        ),
        (
            "set_mask",
            full_snapshot(),
            vec![EditOperation::SetMask {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                mask_id: "mask-new".into(),
                mask_type: MaskType::Ellipse,
                params: None,
            }],
        ),
        (
            "remove_mask",
            full_snapshot(),
            vec![EditOperation::RemoveMask {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                mask_id: "mask-1".into(),
            }],
        ),
        (
            "set_audio_replacement_state",
            full_snapshot(),
            vec![EditOperation::SetAudioReplacementState {
                track_id: "track-audio".into(),
                element_id: "audio-1".into(),
                enabled: false,
            }],
        ),
        (
            "remove_audio_replacement",
            full_snapshot(),
            vec![EditOperation::RemoveAudioReplacement {
                track_id: "track-audio".into(),
                element_id: "audio-1".into(),
            }],
        ),
    ];
    assert_eq!(cases.len(), 41);
    for (name, before, operations) in cases {
        let valid = evaluate(options_with_before(before.clone(), operations.clone()));
        if let Err(error) = valid {
            panic!("valid {name} rejected: {error:?}");
        }
        let invalid_operations = invalid_operations_for(&operations);
        let invalid = evaluate(options_with_before(before, invalid_operations));
        assert!(invalid.is_err(), "invalid {name} unexpectedly validated");
    }
}

#[test]
fn nonactive_scene_prediction_preserves_active_scene_and_uses_real_changed_object_ids() {
    let before = full_snapshot();
    let active_scene_id = before.project.active_scene_id.clone();
    let target_scene_id = before.project.scenes[1].id.clone();
    let untouched_active = before.project.scenes[0].clone();
    let mut request = options_with_before(
        before,
        vec![EditOperation::InsertText {
            element_id: None,
            content: "nonactive".into(),
            start_time: MediaTime::ZERO,
            duration: MediaTime::from_ticks(10_000),
            auto_track_id: None,
            resolved_allocations: None,
        }],
    );
    request.source.scene_id = target_scene_id.clone();
    let result = evaluate(request).unwrap();

    assert_eq!(
        result.predicted_after.project.active_scene_id,
        active_scene_id
    );
    assert_eq!(result.predicted_after.project.scenes[0], untouched_active);
    let EditOperation::InsertText {
        element_id: Some(element_id),
        auto_track_id: Some(track_id),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("insert text IDs were not resolved");
    };
    assert!(
        result
            .changed_objects
            .iter()
            .any(|change| { change.object_type == "track" && change.object_id == *track_id })
    );
    assert!(
        result
            .changed_objects
            .iter()
            .any(|change| { change.object_type == "element" && change.object_id == *element_id })
    );
    assert!(
        result
            .changed_objects
            .iter()
            .all(|change| change.object_id != "canonical-project")
    );
}

#[test]
fn timing_consequences_are_attributed_to_the_operation_that_caused_each_change() {
    let result = evaluate(options_with_before(
        full_snapshot(),
        vec![
            EditOperation::Move {
                track_id: "track-text".into(),
                target_track_id: None,
                element_id: "text-1".into(),
                start_time: MediaTime::from_ticks(1_000),
                relationship_scope: RelationshipScope::Element,
            },
            EditOperation::Move {
                track_id: "track-text".into(),
                target_track_id: None,
                element_id: "text-1".into(),
                start_time: MediaTime::from_ticks(2_000),
                relationship_scope: RelationshipScope::Element,
            },
        ],
    ))
    .unwrap();
    let changes: Vec<_> = result
        .timing_consequences
        .iter()
        .filter(|change| change.element_id == "text-1")
        .collect();
    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].operation_index, 0);
    assert_eq!(changes[0].before_start_ticks, Some(0));
    assert_eq!(changes[0].after_start_ticks, Some(1_000));
    assert_eq!(changes[1].operation_index, 1);
    assert_eq!(changes[1].before_start_ticks, Some(1_000));
    assert_eq!(changes[1].after_start_ticks, Some(2_000));
}

#[test]
fn duration_changes_pin_and_apply_deterministic_animation_boundaries() {
    let mut before = full_snapshot();
    let video = before.project.scenes[0].tracks[0]
        .elements
        .iter_mut()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    video.common_mut().animations = CanonicalValue::Object(BTreeMap::from([(
        "opacity".into(),
        CanonicalValue::Object(BTreeMap::from([(
            "keys".into(),
            CanonicalValue::Array(vec![
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("opacity-start".into())),
                    ("time".into(), CanonicalValue::Integer(0)),
                    ("value".into(), CanonicalValue::Number(0.0)),
                    (
                        "segmentToNext".into(),
                        CanonicalValue::String("linear".into()),
                    ),
                    ("tangentMode".into(), CanonicalValue::String("flat".into())),
                ])),
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("opacity-end".into())),
                    ("time".into(), CanonicalValue::Integer(120_120)),
                    ("value".into(), CanonicalValue::Number(1.0)),
                    (
                        "segmentToNext".into(),
                        CanonicalValue::String("linear".into()),
                    ),
                    ("tangentMode".into(), CanonicalValue::String("flat".into())),
                ])),
            ]),
        )])),
    )]));
    let result = evaluate(options_with_before(
        before,
        vec![EditOperation::SetRetime {
            track_id: "track-main".into(),
            element_id: "video-1".into(),
            rate: 2.0,
            maintain_pitch: None,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let EditOperation::SetRetime {
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("retime duration-clamp IDs were not resolved");
    };
    assert_eq!(allocations.len(), 2);
    assert_eq!(
        allocations[0].role,
        AllocationRole::DurationClampLeftBoundaryKeyframe
    );
    assert_eq!(allocations[0].source_id, "opacity");
    assert_eq!(
        allocations[1].role,
        AllocationRole::DurationClampRightBoundaryKeyframe
    );
    let video = result.predicted_after.project.scenes[0].tracks[0]
        .elements
        .iter()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    assert_eq!(video.common().duration, MediaTime::from_ticks(60_060));
    let CanonicalValue::Object(animations) = &video.common().animations else {
        panic!("retime removed animation storage");
    };
    let CanonicalValue::Object(channel) = &animations["opacity"] else {
        panic!("retime changed opacity channel shape");
    };
    let CanonicalValue::Array(keys) = &channel["keys"] else {
        panic!("retime changed opacity key shape");
    };
    let CanonicalValue::Object(boundary) = keys.last().unwrap() else {
        panic!("retime boundary changed shape");
    };
    assert_eq!(boundary["time"], CanonicalValue::Integer(60_060));
    assert_eq!(
        boundary["id"],
        CanonicalValue::String(allocations[0].resolved_id.clone())
    );
}

#[test]
fn trim_pins_and_applies_deterministic_animation_boundaries() {
    let mut before = full_snapshot();
    let video = before.project.scenes[0].tracks[0]
        .elements
        .iter_mut()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    video.common_mut().animations = CanonicalValue::Object(BTreeMap::from([(
        "opacity".into(),
        CanonicalValue::Object(BTreeMap::from([(
            "keys".into(),
            CanonicalValue::Array(vec![
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("trim-start".into())),
                    ("time".into(), CanonicalValue::Integer(0)),
                    ("value".into(), CanonicalValue::Number(0.0)),
                ])),
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("trim-end".into())),
                    ("time".into(), CanonicalValue::Integer(120_120)),
                    ("value".into(), CanonicalValue::Number(1.0)),
                ])),
            ]),
        )])),
    )]));
    let result = evaluate(options_with_before(
        before,
        vec![EditOperation::Trim {
            track_id: "track-main".into(),
            element_id: "video-1".into(),
            start_time: None,
            duration: Some(MediaTime::from_ticks(60_060)),
            trim_start: MediaTime::ZERO,
            trim_end: MediaTime::from_ticks(60_060),
            ripple: false,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let EditOperation::Trim {
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("trim duration-clamp IDs were not resolved");
    };
    assert_eq!(allocations.len(), 2);
    let video = result.predicted_after.project.scenes[0].tracks[0]
        .elements
        .iter()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    assert_eq!(video.common().duration, MediaTime::from_ticks(60_060));
    let CanonicalValue::Object(animations) = &video.common().animations else {
        panic!("trim removed animation storage");
    };
    let CanonicalValue::Object(channel) = &animations["opacity"] else {
        panic!("trim changed opacity channel shape");
    };
    let CanonicalValue::Array(keys) = &channel["keys"] else {
        panic!("trim changed opacity key shape");
    };
    let CanonicalValue::Object(boundary) = keys.last().unwrap() else {
        panic!("trim boundary changed shape");
    };
    assert_eq!(boundary["time"], CanonicalValue::Integer(60_060));
    assert_eq!(
        boundary["id"],
        CanonicalValue::String(allocations[0].resolved_id.clone())
    );
}

#[test]
fn caption_duration_update_pins_and_applies_deterministic_animation_boundaries() {
    let mut before = full_snapshot();
    let caption = before.project.scenes[0]
        .tracks
        .iter_mut()
        .find(|track| track.id == "track-text")
        .unwrap()
        .elements
        .iter_mut()
        .find(|element| element.common().id == "text-1")
        .unwrap();
    caption.common_mut().animations = CanonicalValue::Object(BTreeMap::from([(
        "opacity".into(),
        CanonicalValue::Object(BTreeMap::from([(
            "keys".into(),
            CanonicalValue::Array(vec![
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("caption-start".into())),
                    ("time".into(), CanonicalValue::Integer(0)),
                    ("value".into(), CanonicalValue::Number(0.0)),
                ])),
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("caption-end".into())),
                    ("time".into(), CanonicalValue::Integer(60_060)),
                    ("value".into(), CanonicalValue::Number(1.0)),
                ])),
            ]),
        )])),
    )]));
    let result = evaluate(options_with_before(
        before,
        vec![EditOperation::UpdateCaption {
            track_id: "track-text".into(),
            element_id: "text-1".into(),
            text: None,
            start_time: None,
            duration: Some(MediaTime::from_ticks(30_030)),
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let EditOperation::UpdateCaption {
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("caption duration-clamp IDs were not resolved");
    };
    assert_eq!(allocations.len(), 2);
    let caption = result.predicted_after.project.scenes[0]
        .tracks
        .iter()
        .find(|track| track.id == "track-text")
        .unwrap()
        .elements
        .iter()
        .find(|element| element.common().id == "text-1")
        .unwrap();
    assert_eq!(caption.common().duration, MediaTime::from_ticks(30_030));
    let CanonicalValue::Object(animations) = &caption.common().animations else {
        panic!("caption update removed animation storage");
    };
    let CanonicalValue::Object(channel) = &animations["opacity"] else {
        panic!("caption update changed opacity channel shape");
    };
    let CanonicalValue::Array(keys) = &channel["keys"] else {
        panic!("caption update changed opacity key shape");
    };
    let CanonicalValue::Object(boundary) = keys.last().unwrap() else {
        panic!("caption update boundary changed shape");
    };
    assert_eq!(boundary["time"], CanonicalValue::Integer(30_030));
    assert_eq!(
        boundary["id"],
        CanonicalValue::String(allocations[0].resolved_id.clone())
    );
}

#[test]
fn created_ids_are_fenced_against_owned_and_nonactive_project_objects() {
    for conflicting_id in ["effect-1", "mask-1", "keyframe-1", "alt-main"] {
        let error = evaluate(options_with_before(
            full_snapshot(),
            vec![EditOperation::InsertText {
                element_id: Some(conflicting_id.into()),
                content: "collision".into(),
                start_time: MediaTime::from_ticks(300_000),
                duration: MediaTime::from_ticks(10_000),
                auto_track_id: None,
                resolved_allocations: None,
            }],
        ))
        .unwrap_err();
        assert!(matches!(error.code, ErrorCode::DuplicateId));
    }
}

fn invalid_operations_for(operations: &[EditOperation]) -> Vec<EditOperation> {
    if matches!(operations.first(), Some(EditOperation::AddTrack { .. })) {
        return vec![EditOperation::AddTrack {
            track_type: TrackType::Graphic,
            track_id: "track-main".into(),
        }];
    }
    let mut value = serde_json::to_value(&operations[0]).unwrap();
    let object = value.as_object_mut().unwrap();
    match object["kind"].as_str().unwrap() {
        "insert_text" | "insert_graphic" | "insert_sticker" | "insert_adjustment_layer" => {
            object.insert("duration".into(), serde_json::json!(0));
        }
        "set_track_state" => {
            object.insert("muted".into(), serde_json::Value::Null);
            object.insert("hidden".into(), serde_json::Value::Null);
        }
        "set_project_settings" => {
            object.insert("fps".into(), serde_json::Value::Null);
            object.insert("canvasSize".into(), serde_json::Value::Null);
            object.insert("background".into(), serde_json::Value::Null);
        }
        "insert_captions" => {
            object.insert("captions".into(), serde_json::json!([]));
        }
        "duplicate_elements" | "create_compound" | "set_group" | "set_link" => {
            object.insert("elements".into(), serde_json::json!([]));
        }
        "clear_group" => {
            object.insert("groupId".into(), serde_json::json!("missing"));
        }
        "clear_link" => {
            object.insert("linkId".into(), serde_json::json!("missing"));
        }
        "adjust_mix_gain" => {
            object.insert("gainDb".into(), serde_json::json!(100));
        }
        "upsert_transition" => {
            object.insert("fromElementId".into(), serde_json::json!("missing"));
        }
        "remove_transition" => {
            object.insert("transitionId".into(), serde_json::json!("missing"));
        }
        _ => {
            object.insert("elementId".into(), serde_json::json!("missing"));
        }
    };
    vec![serde_json::from_value(value).unwrap()]
}

#[test]
fn duplicate_compound_remaps_every_nested_identity_and_preserves_source() {
    let before = full_snapshot();
    let result = evaluate(options_with_before(
        before.clone(),
        vec![EditOperation::DuplicateElements {
            elements: vec![ElementRef {
                track_id: "track-main".into(),
                element_id: "compound-1".into(),
            }],
            duplicate_ids: None,
            relationship_scope: RelationshipScope::Element,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    assert_eq!(result.before, before);
    let EditOperation::DuplicateElements {
        duplicate_ids: Some(duplicate_ids),
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("duplicate operation was not fully resolved");
    };
    assert_eq!(duplicate_ids.len(), 1);
    for role in [
        AllocationRole::DuplicateTrack,
        AllocationRole::DuplicateNestedTrack,
        AllocationRole::DuplicateNestedElement,
    ] {
        assert!(allocations.iter().any(|allocation| allocation.role == role));
    }
    let duplicate = result.predicted_after.project.scenes[0]
        .tracks
        .iter()
        .flat_map(|track| &track.elements)
        .find(|element| element.common().id == duplicate_ids[0])
        .unwrap();
    let CanonicalElement::Compound { tracks, .. } = duplicate else {
        panic!("duplicate did not preserve compound type");
    };
    assert_ne!(tracks[0].id, "nested-main");
    assert_ne!(tracks[0].elements[0].common().id, "nested-image");
}

#[test]
fn split_remaps_owned_objects_and_resolves_animation_boundaries() {
    let mut before = full_snapshot();
    let video = before.project.scenes[0].tracks[0]
        .elements
        .iter_mut()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    let CanonicalValue::Object(animations) = &mut video.common_mut().animations else {
        panic!("fixture animations changed shape");
    };
    let CanonicalValue::Object(opacity) = animations.get_mut("opacity").unwrap() else {
        panic!("fixture opacity channel changed shape");
    };
    let CanonicalValue::Array(keys) = opacity.get_mut("keys").unwrap() else {
        panic!("fixture opacity keys changed shape");
    };
    keys.push(CanonicalValue::Object(BTreeMap::from([
        ("id".into(), CanonicalValue::String("keyframe-2".into())),
        ("time".into(), CanonicalValue::Integer(120_120)),
        ("value".into(), CanonicalValue::Number(0.0)),
        (
            "segmentToNext".into(),
            CanonicalValue::String("linear".into()),
        ),
        ("tangentMode".into(), CanonicalValue::String("auto".into())),
    ])));
    let result = evaluate(options_with_before(
        before,
        vec![EditOperation::Split {
            track_id: "track-main".into(),
            element_id: "video-1".into(),
            split_time: MediaTime::from_ticks(60_060),
            right_element_id: None,
            retain_side: Some(RetainSide::Both),
            ripple: false,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let EditOperation::Split {
        right_element_id: Some(right_id),
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("split operation was not fully resolved");
    };
    for role in [
        AllocationRole::SplitEffect,
        AllocationRole::SplitMask,
        AllocationRole::SplitGroup,
        AllocationRole::SplitLink,
        AllocationRole::SplitLeftBoundaryKeyframe,
        AllocationRole::SplitRightBoundaryKeyframe,
    ] {
        assert!(allocations.iter().any(|allocation| allocation.role == role));
    }
    let left_boundary = allocations
        .iter()
        .find(|allocation| {
            allocation.role == AllocationRole::SplitLeftBoundaryKeyframe
                && allocation.source_id == "opacity"
        })
        .unwrap();
    let right_boundary = allocations
        .iter()
        .find(|allocation| {
            allocation.role == AllocationRole::SplitRightBoundaryKeyframe
                && allocation.source_id == "opacity"
        })
        .unwrap();
    let right = result.predicted_after.project.scenes[0].tracks[0]
        .elements
        .iter()
        .find(|element| element.common().id == *right_id)
        .unwrap();
    let CanonicalElement::Video {
        common,
        effects,
        masks,
        ..
    } = right
    else {
        panic!("split changed element type");
    };
    assert_ne!(common.group_id.as_deref(), Some("group-1"));
    assert_ne!(common.link_id.as_deref(), Some("link-1"));
    assert_ne!(effects[0].id, "effect-1");
    assert_ne!(masks[0].id, "mask-1");
    let CanonicalValue::Object(properties) = &common.animations else {
        panic!("animations were not preserved");
    };
    let CanonicalValue::Object(channel) = &properties["opacity"] else {
        panic!("animation channel was not preserved");
    };
    let CanonicalValue::Array(keys) = &channel["keys"] else {
        panic!("animation keys were not preserved");
    };
    assert_eq!(keys.len(), 2);
    let CanonicalValue::Object(boundary) = &keys[0] else {
        panic!("right boundary key was not preserved");
    };
    assert_eq!(
        boundary["id"],
        CanonicalValue::String(right_boundary.resolved_id.clone())
    );
    assert_eq!(boundary["time"], CanonicalValue::Integer(0));
    assert_eq!(boundary["value"], CanonicalValue::Number(0.5));
    let CanonicalValue::Object(source_key) = &keys[1] else {
        panic!("right source key was not preserved");
    };
    assert_eq!(
        source_key["id"],
        CanonicalValue::String("keyframe-2".into())
    );
    assert_eq!(source_key["time"], CanonicalValue::Integer(60_060));

    let left = result.predicted_after.project.scenes[0].tracks[0]
        .elements
        .iter()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    let CanonicalValue::Object(left_properties) = &left.common().animations else {
        panic!("left animations were not preserved");
    };
    let CanonicalValue::Object(left_channel) = &left_properties["opacity"] else {
        panic!("left animation channel was not preserved");
    };
    let CanonicalValue::Array(left_keys) = &left_channel["keys"] else {
        panic!("left animation keys were not preserved");
    };
    let CanonicalValue::Object(left_boundary_key) = &left_keys[1] else {
        panic!("left boundary key was not preserved");
    };
    assert_eq!(
        left_boundary_key["id"],
        CanonicalValue::String(left_boundary.resolved_id.clone())
    );
    assert_eq!(left_boundary_key["time"], CanonicalValue::Integer(60_060));
}

#[test]
fn split_retimed_clip_retaining_right_remaps_outgoing_transition() {
    let mut before = full_snapshot();
    let video = before.project.scenes[0].tracks[0]
        .elements
        .iter_mut()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    let CanonicalElement::Video { common, retime, .. } = video else {
        panic!("fixture video changed type");
    };
    common.duration = MediaTime::from_ticks(120_000);
    common.source_duration = Some(MediaTime::from_ticks(240_000));
    common.animations = CanonicalValue::Object(BTreeMap::from([(
        "opacity".into(),
        CanonicalValue::Object(BTreeMap::from([(
            "keys".into(),
            CanonicalValue::Array(vec![
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("right-start".into())),
                    ("time".into(), CanonicalValue::Integer(60_000)),
                    ("value".into(), CanonicalValue::Number(0.0)),
                ])),
                CanonicalValue::Object(BTreeMap::from([
                    ("id".into(), CanonicalValue::String("right-end".into())),
                    ("time".into(), CanonicalValue::Integer(240_000)),
                    ("value".into(), CanonicalValue::Number(1.0)),
                ])),
            ]),
        )])),
    )]));
    *retime = CanonicalValue::Object(BTreeMap::from([
        ("rate".into(), CanonicalValue::Number(2.0)),
        ("maintainPitch".into(), CanonicalValue::Boolean(true)),
    ]));
    let result = evaluate(options_with_before(
        before,
        vec![EditOperation::Split {
            track_id: "track-main".into(),
            element_id: "video-1".into(),
            split_time: MediaTime::from_ticks(60_000),
            right_element_id: None,
            retain_side: Some(RetainSide::Right),
            ripple: false,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let EditOperation::Split {
        right_element_id: Some(right_id),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("right-side split ID was not resolved");
    };
    let transition = &result.predicted_after.project.scenes[0].tracks[0].transitions[0];
    assert_eq!(transition.from_element_id, *right_id);
    assert_eq!(transition.to_element_id, "compound-1");
}

#[test]
fn split_matches_bezier_and_discrete_boundary_semantics() {
    let scalar_key = |id: &str, time: i64, value: f64| {
        CanonicalValue::Object(BTreeMap::from([
            ("id".into(), CanonicalValue::String(id.into())),
            ("time".into(), CanonicalValue::Integer(time)),
            ("value".into(), CanonicalValue::Number(value)),
            (
                "segmentToNext".into(),
                CanonicalValue::String("bezier".into()),
            ),
            ("tangentMode".into(), CanonicalValue::String("auto".into())),
        ]))
    };
    let discrete_key = |id: &str, time: i64, value: bool| {
        CanonicalValue::Object(BTreeMap::from([
            ("id".into(), CanonicalValue::String(id.into())),
            ("time".into(), CanonicalValue::Integer(time)),
            ("value".into(), CanonicalValue::Boolean(value)),
        ]))
    };
    let mut before = full_snapshot();
    let video = before.project.scenes[0].tracks[0]
        .elements
        .iter_mut()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    video.common_mut().animations = CanonicalValue::Object(BTreeMap::from([
        (
            "hidden".into(),
            CanonicalValue::Object(BTreeMap::from([(
                "keys".into(),
                CanonicalValue::Array(vec![
                    discrete_key("hidden-0", 0, false),
                    discrete_key("hidden-1", 120_120, true),
                ]),
            )])),
        ),
        (
            "opacity".into(),
            CanonicalValue::Object(BTreeMap::from([(
                "keys".into(),
                CanonicalValue::Array(vec![
                    scalar_key("opacity-0", 0, 0.0),
                    scalar_key("opacity-1", 120_120, 1.0),
                ]),
            )])),
        ),
    ]));
    let result = evaluate(options_with_before(
        before,
        vec![EditOperation::Split {
            track_id: "track-main".into(),
            element_id: "video-1".into(),
            split_time: MediaTime::from_ticks(60_060),
            right_element_id: None,
            retain_side: Some(RetainSide::Both),
            ripple: false,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let EditOperation::Split {
        right_element_id: Some(right_id),
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("split did not resolve");
    };
    let right = result.predicted_after.project.scenes[0].tracks[0]
        .elements
        .iter()
        .find(|element| element.common().id == *right_id)
        .unwrap();
    let CanonicalValue::Object(right_animations) = &right.common().animations else {
        panic!("right animations changed shape");
    };
    let CanonicalValue::Object(opacity) = &right_animations["opacity"] else {
        panic!("right opacity changed shape");
    };
    let CanonicalValue::Array(opacity_keys) = &opacity["keys"] else {
        panic!("right opacity keys changed shape");
    };
    let CanonicalValue::Object(boundary) = &opacity_keys[0] else {
        panic!("right opacity boundary changed shape");
    };
    let expected_boundary_id = allocations
        .iter()
        .find(|allocation| {
            allocation.role == AllocationRole::SplitRightBoundaryKeyframe
                && allocation.source_id == "opacity"
        })
        .unwrap();
    assert_eq!(
        boundary["id"],
        CanonicalValue::String(expected_boundary_id.resolved_id.clone())
    );
    let CanonicalValue::Number(boundary_value) = boundary["value"] else {
        panic!("bezier boundary is not numeric");
    };
    assert!((boundary_value - 0.5).abs() < 0.000_01);
    let CanonicalValue::Object(right_handle) = &boundary["rightHandle"] else {
        panic!("bezier boundary right handle is missing");
    };
    assert_eq!(right_handle["dt"], CanonicalValue::Integer(20_020));

    let CanonicalValue::Object(hidden) = &right_animations["hidden"] else {
        panic!("right discrete channel changed shape");
    };
    let CanonicalValue::Array(hidden_keys) = &hidden["keys"] else {
        panic!("right discrete keys changed shape");
    };
    let CanonicalValue::Object(hidden_boundary) = &hidden_keys[0] else {
        panic!("right discrete boundary changed shape");
    };
    assert_eq!(hidden_boundary["value"], CanonicalValue::Boolean(false));
    assert!(!hidden_boundary.contains_key("segmentToNext"));
}

#[test]
fn break_apart_restores_absolute_timing_track_metadata_and_resolved_ids() {
    let result = evaluate(options_with_before(
        full_snapshot(),
        vec![EditOperation::BreakApartCompound {
            track_id: "track-main".into(),
            element_id: "compound-1".into(),
            restored_element_ids: None,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let EditOperation::BreakApartCompound {
        restored_element_ids: Some(restored_ids),
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[0]
    else {
        panic!("break-apart operation was not fully resolved");
    };
    assert_eq!(restored_ids.len(), 1);
    assert_eq!(allocations[0].role, AllocationRole::BreakApartElement);
    assert_eq!(allocations[0].source_id, "nested-image");
    let restored_track = result.predicted_after.project.scenes[0]
        .tracks
        .iter()
        .find(|track| track.id == "nested-main")
        .unwrap();
    assert_eq!(restored_track.name, "Nested");
    assert_eq!(restored_track.elements[0].common().id, restored_ids[0]);
    assert_eq!(
        restored_track.elements[0].common().start_time,
        MediaTime::from_ticks(120_120)
    );
}

#[test]
fn freeform_mask_path_round_trips_without_stringification() {
    let operation: EditOperation = serde_json::from_value(serde_json::json!({
        "kind": "set_mask",
        "trackId": "track-main",
        "elementId": "video-1",
        "maskId": "freeform-mask",
        "maskType": "freeform",
        "params": {
            "path": [{ "id": "point-a", "x": 0.1, "y": 0.2, "inX": 0.0, "inY": 0.0, "outX": 0.3, "outY": 0.4 }]
        }
    }))
    .unwrap();
    let result = evaluate(options_with_before(full_snapshot(), vec![operation])).unwrap();
    let CanonicalElement::Video { masks, .. } =
        &result.predicted_after.project.scenes[0].tracks[0].elements[0]
    else {
        panic!("fixture video changed type");
    };
    let CanonicalValue::Object(params) = &masks.last().unwrap().params else {
        panic!("mask params changed shape");
    };
    assert!(matches!(params["path"], CanonicalValue::Array(_)));
}

#[test]
fn text_mask_accepts_and_validates_its_complete_typed_parameter_contract() {
    let operation: EditOperation = serde_json::from_value(serde_json::json!({
        "kind": "set_mask",
        "trackId": "track-main",
        "elementId": "video-1",
        "maskId": "text-mask",
        "maskType": "text",
        "params": {
            "content": "MASK",
            "fontSize": 24,
            "fontFamily": "Inter",
            "fontWeight": "bold",
            "fontStyle": "italic",
            "textDecoration": "underline",
            "letterSpacing": -101,
            "lineHeight": 0.01,
            "inverted": true
        }
    }))
    .unwrap();
    let result = evaluate(options_with_before(full_snapshot(), vec![operation])).unwrap();
    let CanonicalElement::Video { masks, .. } =
        &result.predicted_after.project.scenes[0].tracks[0].elements[0]
    else {
        panic!("fixture video changed type");
    };
    let CanonicalValue::Object(params) = &masks[0].params else {
        panic!("text mask params changed shape");
    };
    assert_eq!(params["content"], CanonicalValue::String("MASK".into()));
    assert_eq!(params["fontFamily"], CanonicalValue::String("Inter".into()));
    assert_eq!(params["fontWeight"], CanonicalValue::String("bold".into()));
    assert_eq!(params["fontStyle"], CanonicalValue::String("italic".into()));
    assert_eq!(
        params["textDecoration"],
        CanonicalValue::String("underline".into())
    );
    assert_eq!(params["letterSpacing"], CanonicalValue::Number(-100.0));
    assert_eq!(params["lineHeight"], CanonicalValue::Number(0.1));
    assert_eq!(params["inverted"], CanonicalValue::Boolean(true));

    let invalid: EditOperation = serde_json::from_value(serde_json::json!({
        "kind": "set_mask",
        "trackId": "track-main",
        "elementId": "video-1",
        "maskId": "text-mask",
        "maskType": "text",
        "params": { "fontWeight": "heavy" }
    }))
    .unwrap();
    let error = evaluate(options_with_before(full_snapshot(), vec![invalid])).unwrap_err();
    assert!(matches!(error.code, ErrorCode::InvalidValue));
}

#[test]
fn exact_no_op_and_invalid_created_reference_fail_closed() {
    let no_op = evaluate(options(vec![EditOperation::SetTrackState {
        track_id: "main".into(),
        muted: Some(false),
        hidden: None,
    }]))
    .unwrap_err();
    assert!(matches!(no_op.code, ErrorCode::SilentNoOp));

    let invalid_reference = evaluate(options(vec![EditOperation::Move {
        track_id: "main".into(),
        target_track_id: None,
        element_id: "missing".into(),
        start_time: MediaTime::ZERO,
        relationship_scope: RelationshipScope::Element,
    }]))
    .unwrap_err();
    assert!(matches!(
        invalid_reference.code,
        ErrorCode::UnknownReference
    ));
}

#[test]
fn reframe_audio_fade_and_ducking_write_exact_canonical_controls() {
    let result = evaluate(options_with_before(
        full_snapshot(),
        vec![
            EditOperation::SetReframe {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                mode: Some(ReframeMode::Fill),
                crop: None,
                focal_point: Some(Point { x: 0.25, y: 0.75 }),
                target_rect: None,
                layout: Some(ReframeLayout::PipBottomRight),
            },
            EditOperation::SetAudio {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                volume_db: Some(-6.0),
                muted: Some(true),
                fade: Some(Fade {
                    in_duration: MediaTime::from_ticks(1_000),
                    out_duration: MediaTime::from_ticks(2_000),
                    floor_db: -60.0,
                }),
                resolved_allocations: None,
            },
            EditOperation::DuckAudio {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                regions: vec![Region {
                    start_time: MediaTime::from_ticks(20_000),
                    duration: MediaTime::from_ticks(30_000),
                }],
                reduction_db: 9.0,
                attack_duration: MediaTime::from_ticks(1_000),
                release_duration: MediaTime::from_ticks(2_000),
                resolved_allocations: None,
            },
        ],
    ))
    .unwrap();
    let element = &result.predicted_after.project.scenes[0].tracks[0].elements[0];
    let params = match &element.common().params {
        CanonicalValue::Object(params) => params,
        _ => panic!("element params changed shape"),
    };
    assert_eq!(params["volume"], CanonicalValue::Number(-6.0));
    assert_eq!(params["muted"], CanonicalValue::Boolean(true));
    assert_eq!(
        params["reframe.mode"],
        CanonicalValue::String("cover".into())
    );
    assert_eq!(params["reframe.focalX"], CanonicalValue::Number(0.25));
    assert_eq!(params["reframe.targetX"], CanonicalValue::Number(0.64));
    let animations = match &element.common().animations {
        CanonicalValue::Object(animations) => animations,
        _ => panic!("element animations changed shape"),
    };
    assert!(animations.contains_key("volume"));
    assert!(animations.contains_key("ducking"));
    for operation in &result.resolved_operations[1..] {
        let allocations = match operation {
            EditOperation::SetAudio {
                resolved_allocations: Some(allocations),
                ..
            }
            | EditOperation::DuckAudio {
                resolved_allocations: Some(allocations),
                ..
            } => allocations,
            _ => panic!("generated keyframes were not resolved"),
        };
        assert!(!allocations.is_empty());
        assert!(
            allocations
                .iter()
                .all(|allocation| allocation.role == AllocationRole::Keyframe)
        );
    }
}

#[test]
fn untouched_elements_in_the_edited_scene_remain_canonical_byte_equivalent() {
    let before = full_snapshot();
    let original_video = before.project.scenes[0].tracks[0].elements[0].clone();
    let result = evaluate(options_with_before(
        before,
        vec![EditOperation::InsertText {
            element_id: None,
            content: "additional".into(),
            start_time: MediaTime::from_ticks(200_000),
            duration: MediaTime::from_ticks(10_000),
            auto_track_id: None,
            resolved_allocations: None,
        }],
    ))
    .unwrap();
    let predicted_video = result.predicted_after.project.scenes[0].tracks[0]
        .elements
        .iter()
        .find(|element| element.common().id == "video-1")
        .unwrap();
    assert_eq!(predicted_video, &original_video);
}

#[test]
fn source_audio_separation_preserves_media_and_remaps_gain_keyframes() {
    let result = evaluate(options_with_before(
        full_snapshot(),
        vec![
            EditOperation::SetAudio {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                volume_db: Some(-3.0),
                muted: None,
                fade: Some(Fade {
                    in_duration: MediaTime::from_ticks(1_000),
                    out_duration: MediaTime::from_ticks(1_000),
                    floor_db: -60.0,
                }),
                resolved_allocations: None,
            },
            EditOperation::SeparateSourceAudio {
                track_id: "track-main".into(),
                element_id: "video-1".into(),
                audio_track_id: None,
                audio_element_id: None,
                link_id: None,
                resolved_allocations: None,
            },
        ],
    ))
    .unwrap();
    let EditOperation::SeparateSourceAudio {
        audio_track_id: Some(audio_track_id),
        audio_element_id: Some(audio_element_id),
        resolved_allocations: Some(allocations),
        ..
    } = &result.resolved_operations[1]
    else {
        panic!("source audio operation was not fully resolved");
    };
    let audio_track_ids: Vec<_> = result.predicted_after.project.scenes[0]
        .tracks
        .iter()
        .filter(|track| track.role == "audio")
        .map(|track| track.id.as_str())
        .collect();
    assert_eq!(
        audio_track_ids,
        vec![audio_track_id.as_str(), "track-audio"]
    );
    assert_eq!(allocations.len(), 4);
    let audio = result.predicted_after.project.scenes[0]
        .tracks
        .iter()
        .find(|track| track.id == *audio_track_id)
        .unwrap()
        .elements
        .iter()
        .find(|element| element.common().id == *audio_element_id)
        .unwrap();
    let CanonicalElement::Audio {
        media_id, common, ..
    } = audio
    else {
        panic!("separated element is not audio");
    };
    assert_eq!(media_id.as_deref(), Some("media-video"));
    let CanonicalValue::Object(animations) = &common.animations else {
        panic!("source audio animations changed shape");
    };
    assert!(animations.contains_key("volume"));
    assert!(!animations.contains_key("opacity"));
}

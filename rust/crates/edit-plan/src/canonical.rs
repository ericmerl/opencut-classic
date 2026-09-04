use std::collections::BTreeMap;

use time::{FrameRate, MediaTime};

use crate::{
    ActiveSceneSnapshot, Background, Bookmark, CanonicalBookmark, CanonicalEffect,
    CanonicalElement, CanonicalElementCommon, CanonicalMask, CanonicalObject, CanonicalTrack,
    CanonicalTransition, CanonicalValue, CanvasSize, EditPlanError, Effect, Element, ErrorCode,
    FreeformPathPoint, Keyframe, Mask, MaskParamValue, MaskParams, Params, ProjectSettings,
    ProjectSnapshot, Scalar, Track, Transition,
};

pub(crate) fn validate_projection(
    snapshot: &ProjectSnapshot,
    scene_id: &str,
) -> Result<(), EditPlanError> {
    if snapshot.projection != crate::PROJECT_CONTENT_PROJECTION
        || !matches!(
            snapshot.projection_version,
            crate::PROJECT_CONTENT_PROJECTION_VERSION
                | crate::PROJECT_CONTENT_PROJECTION_VERSION_2
                | crate::CURRENT_PROJECT_CONTENT_PROJECTION_VERSION
        )
    {
        return Err(projection_error(
            ErrorCode::SnapshotVersion,
            "before must be a supported opencut-project-content projection",
            "before",
        ));
    }
    if snapshot
        .project
        .scenes
        .iter()
        .all(|scene| scene.id != scene_id)
    {
        return Err(projection_error(
            ErrorCode::UnknownReference,
            "requested canonical scene is missing",
            "before.project.scenes",
        ));
    }
    validate_orders(snapshot)?;
    validate_canonical_value(&CanonicalValue::Object(snapshot.project.settings.clone()))?;
    Ok(())
}

pub(crate) fn extract_active(
    snapshot: &ProjectSnapshot,
    project_id: &str,
    scene_id: &str,
) -> Result<ActiveSceneSnapshot, EditPlanError> {
    validate_projection(snapshot, scene_id)?;
    if snapshot.projection_version >= crate::PROJECT_CONTENT_PROJECTION_VERSION_2
        && snapshot.project.id.as_deref() != Some(project_id)
    {
        return Err(projection_error(
            ErrorCode::SourceMismatch,
            "project identity does not match the v2 projection",
            "before.project.id",
        ));
    }
    let scene = snapshot
        .project
        .scenes
        .iter()
        .find(|candidate| candidate.id == scene_id)
        .expect("validated scene");
    let settings = project_settings(&snapshot.project.settings)?;
    // Native timeline commands address tracks in visual order: overlays, main,
    // then audio. The canonical project projection serializes main first.
    let tracks = scene
        .tracks
        .iter()
        .filter(|track| track.role == "overlay")
        .chain(scene.tracks.iter().filter(|track| track.role == "main"))
        .chain(scene.tracks.iter().filter(|track| track.role == "audio"))
        .map(active_track)
        .collect();
    let transitions = scene
        .tracks
        .iter()
        .flat_map(|track| {
            track.transitions.iter().map(|transition| Transition {
                transition_id: transition.id.clone(),
                track_id: track.id.clone(),
                from_element_id: transition.from_element_id.clone(),
                to_element_id: transition.to_element_id.clone(),
                transition_type: transition.transition_type.clone(),
                duration: transition.duration,
            })
        })
        .collect();
    let elements = scene
        .tracks
        .iter()
        .flat_map(|track| {
            track
                .elements
                .iter()
                .map(|element| active_element(&track.id, element))
        })
        .collect();
    let bookmarks = scene
        .bookmarks
        .iter()
        .map(|bookmark| Bookmark {
            bookmark_id: bookmark.id.clone(),
            time: bookmark.time,
            duration: bookmark.duration,
            note: bookmark.note.clone(),
            color: bookmark.color.clone(),
        })
        .collect();
    Ok(ActiveSceneSnapshot {
        schema_version: super::SNAPSHOT_VERSION.into(),
        project_id: project_id.into(),
        project_name: snapshot.project.name.clone(),
        project_version: 0,
        scene_id: scene.id.clone(),
        scene_name: scene.name.clone(),
        settings,
        tracks,
        transitions,
        elements,
        bookmarks,
    })
}

pub(crate) fn merge_active(
    snapshot: &ProjectSnapshot,
    active: &ActiveSceneSnapshot,
) -> Result<ProjectSnapshot, EditPlanError> {
    let mut result = snapshot.clone();
    update_settings(&mut result.project.settings, &active.settings);
    let scene = result
        .project
        .scenes
        .iter_mut()
        .find(|scene| scene.id == active.scene_id)
        .ok_or_else(|| {
            projection_error(
                ErrorCode::UnknownReference,
                "requested canonical scene is missing",
                "before.project.scenes",
            )
        })?;
    let old_tracks: BTreeMap<String, CanonicalTrack> = scene
        .tracks
        .iter()
        .cloned()
        .map(|track| (track.id.clone(), track))
        .collect();
    scene.tracks = active
        .tracks
        .iter()
        .enumerate()
        .map(|(track_order, track)| {
            let old = old_tracks.get(&track.track_id);
            let old_elements: BTreeMap<String, CanonicalElement> = old
                .map(|track| {
                    track
                        .elements
                        .iter()
                        .cloned()
                        .map(|element| (element.common().id.clone(), element))
                        .collect()
                })
                .unwrap_or_default();
            let mut elements: Vec<_> = active
                .elements
                .iter()
                .filter(|element| element.track_id == track.track_id)
                .enumerate()
                .map(|(order, element)| {
                    canonical_element(element, order, old_elements.get(&element.element_id))
                })
                .collect();
            elements.sort_by_key(|element| element.common().order);
            let transitions = active
                .transitions
                .iter()
                .filter(|transition| transition.track_id == track.track_id)
                .enumerate()
                .map(|(order, transition)| CanonicalTransition {
                    order,
                    id: transition.transition_id.clone(),
                    from_element_id: transition.from_element_id.clone(),
                    to_element_id: transition.to_element_id.clone(),
                    transition_type: transition.transition_type.clone(),
                    duration: transition.duration,
                })
                .collect();
            CanonicalTrack {
                role: track.role.clone(),
                order: role_order(track, track_order),
                id: track.track_id.clone(),
                name: track.name.clone(),
                track_type: track.track_type.clone(),
                muted: track.muted,
                hidden: track.hidden,
                transitions,
                elements,
            }
        })
        .collect();
    scene.tracks.sort_by_key(|track| match track.role.as_str() {
        "main" => 0,
        "overlay" => 1,
        "audio" => 2,
        _ => 3,
    });
    normalize_track_orders(&mut scene.tracks);
    scene.bookmarks = active
        .bookmarks
        .iter()
        .enumerate()
        .map(|(order, bookmark)| CanonicalBookmark {
            order,
            id: bookmark.bookmark_id.clone(),
            time: bookmark.time,
            duration: bookmark.duration,
            note: bookmark.note.clone(),
            color: bookmark.color.clone(),
        })
        .collect();
    Ok(result)
}

fn validate_orders(snapshot: &ProjectSnapshot) -> Result<(), EditPlanError> {
    for (scene_order, scene) in snapshot.project.scenes.iter().enumerate() {
        if scene.order != scene_order {
            return Err(projection_error(
                ErrorCode::InvalidValue,
                "scene order field does not match array order",
                "before.project.scenes.order",
            ));
        }
        for (bookmark_order, bookmark) in scene.bookmarks.iter().enumerate() {
            if bookmark.order != bookmark_order {
                return Err(projection_error(
                    ErrorCode::InvalidValue,
                    "bookmark order field does not match array order",
                    "before.project.scenes.bookmarks.order",
                ));
            }
        }
        for track in &scene.tracks {
            for (element_order, element) in track.elements.iter().enumerate() {
                if element.common().order != element_order {
                    return Err(projection_error(
                        ErrorCode::InvalidValue,
                        "element order field does not match array order",
                        "before.project.scenes.tracks.elements.order",
                    ));
                }
                validate_canonical_value(&element.common().params)?;
                validate_canonical_value(&element.common().animations)?;
            }
        }
    }
    let mut media_ids: Vec<_> = snapshot
        .media_assets
        .iter()
        .map(|asset| asset.id.as_str())
        .collect();
    let before = media_ids.clone();
    media_ids.sort_unstable();
    if media_ids != before || media_ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(projection_error(
            ErrorCode::InvalidValue,
            "media assets must be unique and ordinally sorted by ID",
            "before.mediaAssets",
        ));
    }
    Ok(())
}

fn validate_canonical_value(value: &CanonicalValue) -> Result<(), EditPlanError> {
    match value {
        CanonicalValue::Number(number) if !number.is_finite() => Err(projection_error(
            ErrorCode::InvalidValue,
            "canonical project contains a non-finite number",
            "before",
        )),
        CanonicalValue::Array(values) => values.iter().try_for_each(validate_canonical_value),
        CanonicalValue::Object(values) => values.values().try_for_each(validate_canonical_value),
        _ => Ok(()),
    }
}

fn project_settings(settings: &CanonicalObject) -> Result<ProjectSettings, EditPlanError> {
    let fps = object(settings.get("fps"), "settings.fps")?;
    let canvas = object(settings.get("canvasSize"), "settings.canvasSize")?;
    let background = object(settings.get("background"), "settings.background")?;
    let numerator = unsigned(fps.get("numerator"), "settings.fps.numerator")?;
    let denominator = unsigned(fps.get("denominator"), "settings.fps.denominator")?;
    let width = unsigned(canvas.get("width"), "settings.canvasSize.width")?;
    let height = unsigned(canvas.get("height"), "settings.canvasSize.height")?;
    let kind = string(background.get("type"), "settings.background.type")?;
    let background = match kind {
        "color" => Background::Color {
            color: string(background.get("color"), "settings.background.color")?.into(),
        },
        "blur" => Background::Blur {
            blur_intensity: unsigned(
                background.get("blurIntensity"),
                "settings.background.blurIntensity",
            )?,
        },
        _ => {
            return Err(projection_error(
                ErrorCode::InvalidValue,
                "unknown canonical background type",
                "settings.background.type",
            ));
        }
    };
    Ok(ProjectSettings {
        fps: FrameRate::new(numerator, denominator),
        canvas_size: CanvasSize { width, height },
        background,
        canvas_size_mode: optional_string(settings.get("canvasSizeMode"))?,
        last_custom_canvas_size: optional_canvas_size(settings.get("lastCustomCanvasSize"))?,
    })
}

fn optional_string(value: Option<&CanonicalValue>) -> Result<Option<String>, EditPlanError> {
    match value {
        None | Some(CanonicalValue::Null(())) => Ok(None),
        Some(CanonicalValue::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(projection_error(
            ErrorCode::InvalidValue,
            "canonical setting must be a string or null",
            "settings",
        )),
    }
}

fn optional_canvas_size(
    value: Option<&CanonicalValue>,
) -> Result<Option<CanvasSize>, EditPlanError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if matches!(value, CanonicalValue::Null(())) {
        return Ok(None);
    }
    let object = object(Some(value), "settings.lastCustomCanvasSize")?;
    let width = unsigned(object.get("width"), "settings.lastCustomCanvasSize.width")?;
    let height = unsigned(object.get("height"), "settings.lastCustomCanvasSize.height")?;
    Ok(Some(CanvasSize { width, height }))
}

fn update_settings(settings: &mut CanonicalObject, active: &ProjectSettings) {
    settings.insert(
        "fps".into(),
        CanonicalValue::Object(BTreeMap::from([
            (
                "denominator".into(),
                CanonicalValue::Unsigned(u64::from(active.fps.denominator)),
            ),
            (
                "numerator".into(),
                CanonicalValue::Unsigned(u64::from(active.fps.numerator)),
            ),
        ])),
    );
    settings.insert(
        "canvasSize".into(),
        CanonicalValue::Object(BTreeMap::from([
            (
                "height".into(),
                CanonicalValue::Unsigned(u64::from(active.canvas_size.height)),
            ),
            (
                "width".into(),
                CanonicalValue::Unsigned(u64::from(active.canvas_size.width)),
            ),
        ])),
    );
    if let Some(mode) = &active.canvas_size_mode {
        settings.insert(
            "canvasSizeMode".into(),
            CanonicalValue::String(mode.clone()),
        );
    }
    if let Some(size) = &active.last_custom_canvas_size {
        settings.insert(
            "lastCustomCanvasSize".into(),
            CanonicalValue::Object(BTreeMap::from([
                (
                    "height".into(),
                    CanonicalValue::Unsigned(u64::from(size.height)),
                ),
                (
                    "width".into(),
                    CanonicalValue::Unsigned(u64::from(size.width)),
                ),
            ])),
        );
    }
    let background = match &active.background {
        Background::Color { color } => BTreeMap::from([
            ("color".into(), CanonicalValue::String(color.clone())),
            ("type".into(), CanonicalValue::String("color".into())),
        ]),
        Background::Blur { blur_intensity } => BTreeMap::from([
            (
                "blurIntensity".into(),
                CanonicalValue::Unsigned(u64::from(*blur_intensity)),
            ),
            ("type".into(), CanonicalValue::String("blur".into())),
        ]),
    };
    settings.insert("background".into(), CanonicalValue::Object(background));
}

fn active_track(track: &CanonicalTrack) -> Track {
    Track {
        track_id: track.id.clone(),
        name: track.name.clone(),
        track_type: track.track_type.clone(),
        role: track.role.clone(),
        muted: track.muted,
        hidden: track.hidden,
    }
}

fn active_element(track_id: &str, element: &CanonicalElement) -> Element {
    active_element_at(track_id, element, MediaTime::ZERO)
}

fn active_element_at(
    track_id: &str,
    element: &CanonicalElement,
    time_origin: MediaTime,
) -> Element {
    let common = element.common();
    let mut result = Element {
        element_id: common.id.clone(),
        track_id: track_id.into(),
        element_type: element.kind().into(),
        name: common.name.clone(),
        definition_id: match element {
            CanonicalElement::Graphic { definition_id, .. } => Some(definition_id.clone()),
            _ => None,
        },
        sticker_id: match element {
            CanonicalElement::Sticker { sticker_id, .. } => Some(sticker_id.clone()),
            _ => None,
        },
        effect_type: match element {
            CanonicalElement::Effect { effect_type, .. } => Some(effect_type.clone()),
            _ => None,
        },
        start_time: MediaTime::from_ticks(
            time_origin
                .as_ticks()
                .checked_add(common.start_time.as_ticks())
                .expect("validated canonical compound timing"),
        ),
        duration: common.duration,
        trim_start: common.trim_start,
        trim_end: common.trim_end,
        source_duration: common.source_duration,
        text: scalar_string(&common.params, "content").map(str::to_owned),
        params: scalar_params(&common.params),
        canonical_params: common.params.clone(),
        canonical_source: Some(element.clone()),
        reframe: None,
        volume_db: scalar_number(&common.params, "volume"),
        muted: scalar_bool(&common.params, "muted"),
        fade: None,
        retime_rate: None,
        maintain_pitch: None,
        effects: vec![],
        keyframes: parse_keyframes(&common.animations),
        masks: vec![],
        matte_enabled: None,
        audio_replacement_enabled: None,
        source_audio_separated: None,
        ducking: vec![],
        group_id: common.group_id.clone(),
        link_id: common.link_id.clone(),
        compound_tracks: vec![],
        compound_transitions: vec![],
        compound_members: vec![],
        compound_empty_main_track_id: None,
    };
    match element {
        CanonicalElement::Audio {
            retime,
            audio_replacement,
            ..
        } => {
            read_retime(retime, &mut result);
            result.audio_replacement_enabled = audio_replacement.as_ref().map(|a| a.enabled);
        }
        CanonicalElement::Video {
            is_source_audio_enabled,
            retime,
            effects,
            masks,
            matte,
            audio_replacement,
            ..
        } => {
            read_retime(retime, &mut result);
            result.source_audio_separated = is_source_audio_enabled.map(|enabled| !enabled);
            result.effects = effects.iter().map(active_effect).collect();
            result.masks = masks.iter().map(active_mask).collect();
            result.matte_enabled = matte.as_ref().map(|a| a.enabled);
            result.audio_replacement_enabled = audio_replacement.as_ref().map(|a| a.enabled);
        }
        CanonicalElement::Image { effects, masks, .. }
        | CanonicalElement::Graphic { effects, masks, .. } => {
            result.effects = effects.iter().map(active_effect).collect();
            result.masks = masks.iter().map(active_mask).collect();
        }
        CanonicalElement::Text { effects, .. } | CanonicalElement::Sticker { effects, .. } => {
            result.effects = effects.iter().map(active_effect).collect();
        }
        CanonicalElement::Compound { tracks, .. } => {
            result.compound_tracks = tracks.iter().map(active_track).collect();
            result.compound_transitions = tracks
                .iter()
                .flat_map(|track| {
                    track.transitions.iter().map(|transition| Transition {
                        transition_id: transition.id.clone(),
                        track_id: track.id.clone(),
                        from_element_id: transition.from_element_id.clone(),
                        to_element_id: transition.to_element_id.clone(),
                        transition_type: transition.transition_type.clone(),
                        duration: transition.duration,
                    })
                })
                .collect();
            result.compound_empty_main_track_id = tracks
                .iter()
                .find(|track| track.role == "main" && track.elements.is_empty())
                .map(|track| track.id.clone());
            let child_origin = MediaTime::from_ticks(
                result
                    .start_time
                    .as_ticks()
                    .checked_sub(result.trim_start.as_ticks())
                    .expect("validated canonical compound trim"),
            );
            result.compound_members = tracks
                .iter()
                .flat_map(|track| {
                    track
                        .elements
                        .iter()
                        .map(move |element| active_element_at(&track.id, element, child_origin))
                })
                .collect();
        }
        CanonicalElement::Effect { .. } => {}
    }
    if matches!(result.element_type.as_str(), "video" | "image") {
        result.reframe = reframe_from_params(&result.canonical_params);
    }
    result
}

fn canonical_element(
    element: &Element,
    order: usize,
    existing: Option<&CanonicalElement>,
) -> CanonicalElement {
    let source = existing.or(element.canonical_source.as_ref());
    let mut common = source
        .map(|value| value.common().clone())
        .unwrap_or_else(|| empty_common(element, order));
    common.order = order;
    common.id = element.element_id.clone();
    common.name = element.name.clone();
    common.group_id = element.group_id.clone();
    common.link_id = element.link_id.clone();
    common.start_time = element.start_time;
    common.duration = element.duration;
    common.trim_start = element.trim_start;
    common.trim_end = element.trim_end;
    common.source_duration = element.source_duration;
    common.params = element.canonical_params.clone();
    merge_scalar_params(&mut common.params, &element.params);
    write_element_controls(&mut common.params, element);
    sync_keyframes(&mut common.animations, &element.keyframes);
    if let Some(text) = &element.text {
        set_object_field(
            &mut common.params,
            "content",
            CanonicalValue::String(text.clone()),
        );
    }
    let common = Box::new(common);
    match (element.element_type.as_str(), source) {
        (
            "audio",
            Some(CanonicalElement::Audio {
                source_type,
                media_id,
                source_url,
                retime,
                audio_replacement,
                ..
            }),
        ) => CanonicalElement::Audio {
            common,
            source_type: source_type.clone(),
            media_id: media_id.clone(),
            source_url: source_url.clone(),
            retime: write_retime(retime.clone(), element),
            audio_replacement: update_attachment(
                audio_replacement.clone(),
                element.audio_replacement_enabled,
            ),
        },
        (
            "video",
            Some(CanonicalElement::Video {
                media_id,
                hidden,
                retime,
                effects,
                masks,
                matte,
                audio_replacement,
                ..
            }),
        ) => CanonicalElement::Video {
            common,
            media_id: media_id.clone(),
            hidden: *hidden,
            is_source_audio_enabled: element.source_audio_separated.map(|separated| !separated),
            retime: write_retime(retime.clone(), element),
            effects: canonical_effects(&element.effects, effects),
            masks: canonical_masks(&element.masks, masks),
            matte: update_attachment(matte.clone(), element.matte_enabled),
            audio_replacement: update_attachment(
                audio_replacement.clone(),
                element.audio_replacement_enabled,
            ),
        },
        (
            "image",
            Some(CanonicalElement::Image {
                media_id,
                hidden,
                effects,
                masks,
                ..
            }),
        ) => CanonicalElement::Image {
            common,
            media_id: media_id.clone(),
            hidden: *hidden,
            effects: canonical_effects(&element.effects, effects),
            masks: canonical_masks(&element.masks, masks),
        },
        (
            "text",
            Some(CanonicalElement::Text {
                hidden, effects, ..
            }),
        ) => CanonicalElement::Text {
            common,
            hidden: *hidden,
            effects: canonical_effects(&element.effects, effects),
        },
        (
            "sticker",
            Some(CanonicalElement::Sticker {
                sticker_id,
                intrinsic_width,
                intrinsic_height,
                hidden,
                effects,
                ..
            }),
        ) => CanonicalElement::Sticker {
            common,
            sticker_id: sticker_id.clone(),
            intrinsic_width: *intrinsic_width,
            intrinsic_height: *intrinsic_height,
            hidden: *hidden,
            effects: canonical_effects(&element.effects, effects),
        },
        (
            "graphic",
            Some(CanonicalElement::Graphic {
                definition_id,
                hidden,
                effects,
                masks,
                ..
            }),
        ) => CanonicalElement::Graphic {
            common,
            definition_id: definition_id.clone(),
            hidden: *hidden,
            effects: canonical_effects(&element.effects, effects),
            masks: canonical_masks(&element.masks, masks),
        },
        ("effect", Some(CanonicalElement::Effect { effect_type, .. })) => {
            CanonicalElement::Effect {
                common,
                effect_type: effect_type.clone(),
            }
        }
        ("compound", Some(CanonicalElement::Compound { hidden, tracks, .. }))
            if element.compound_members.is_empty() =>
        {
            CanonicalElement::Compound {
                common,
                hidden: *hidden,
                tracks: tracks.clone(),
            }
        }
        ("compound", _) => CanonicalElement::Compound {
            common,
            hidden: Some(false),
            tracks: compound_tracks(
                &element.compound_members,
                &element.compound_tracks,
                &element.compound_transitions,
                element.compound_empty_main_track_id.as_deref(),
                MediaTime::from_ticks(
                    element.start_time.as_ticks() - element.trim_start.as_ticks(),
                ),
            ),
        },
        ("graphic", _) => CanonicalElement::Graphic {
            common,
            definition_id: element.definition_id.clone().unwrap_or_default(),
            hidden: None,
            effects: canonical_effects(&element.effects, &[]),
            masks: canonical_masks(&element.masks, &[]),
        },
        ("sticker", _) => CanonicalElement::Sticker {
            common,
            sticker_id: element.sticker_id.clone().unwrap_or_default(),
            intrinsic_width: None,
            intrinsic_height: None,
            hidden: None,
            effects: canonical_effects(&element.effects, &[]),
        },
        ("effect", _) => CanonicalElement::Effect {
            common,
            effect_type: element.effect_type.clone().unwrap_or_default(),
        },
        ("audio", _) => CanonicalElement::Audio {
            common,
            source_type: "upload".into(),
            media_id: None,
            source_url: None,
            retime: CanonicalValue::Null(()),
            audio_replacement: None,
        },
        ("video", _) => CanonicalElement::Video {
            common,
            media_id: String::new(),
            hidden: Some(false),
            is_source_audio_enabled: Some(true),
            retime: CanonicalValue::Null(()),
            effects: vec![],
            masks: vec![],
            matte: None,
            audio_replacement: None,
        },
        ("image", _) => CanonicalElement::Image {
            common,
            media_id: String::new(),
            hidden: Some(false),
            effects: vec![],
            masks: vec![],
        },
        _ => CanonicalElement::Text {
            common,
            hidden: None,
            effects: canonical_effects(&element.effects, &[]),
        },
    }
}

fn empty_common(element: &Element, order: usize) -> CanonicalElementCommon {
    CanonicalElementCommon {
        order,
        id: element.element_id.clone(),
        name: element.name.clone(),
        group_id: element.group_id.clone(),
        link_id: element.link_id.clone(),
        start_time: element.start_time,
        duration: element.duration,
        trim_start: element.trim_start,
        trim_end: element.trim_end,
        source_duration: None,
        params: element.canonical_params.clone(),
        animations: CanonicalValue::Object(BTreeMap::new()),
    }
}

fn reframe_from_params(params: &CanonicalValue) -> Option<crate::Reframe> {
    let CanonicalValue::Object(params) = params else {
        return None;
    };
    if !params.keys().any(|key| key.starts_with("reframe.")) {
        return None;
    }
    Some(crate::Reframe {
        mode: Some(
            scalar_string_from(params.get("reframe.mode"))
                .unwrap_or("contain")
                .into(),
        ),
        crop: Some(crate::Rect {
            x: scalar_number_from(params.get("reframe.cropX")).unwrap_or(0.0),
            y: scalar_number_from(params.get("reframe.cropY")).unwrap_or(0.0),
            width: scalar_number_from(params.get("reframe.cropWidth")).unwrap_or(1.0),
            height: scalar_number_from(params.get("reframe.cropHeight")).unwrap_or(1.0),
        }),
        focal_point: Some(crate::Point {
            x: scalar_number_from(params.get("reframe.focalX")).unwrap_or(0.5),
            y: scalar_number_from(params.get("reframe.focalY")).unwrap_or(0.5),
        }),
        target_rect: Some(crate::Rect {
            x: scalar_number_from(params.get("reframe.targetX")).unwrap_or(0.0),
            y: scalar_number_from(params.get("reframe.targetY")).unwrap_or(0.0),
            width: scalar_number_from(params.get("reframe.targetWidth")).unwrap_or(1.0),
            height: scalar_number_from(params.get("reframe.targetHeight")).unwrap_or(1.0),
        }),
        layout: None,
    })
}

fn scalar_string_from(value: Option<&CanonicalValue>) -> Option<&str> {
    match value {
        Some(CanonicalValue::String(value)) => Some(value),
        _ => None,
    }
}

fn write_element_controls(params: &mut CanonicalValue, element: &Element) {
    if let Some(volume) = element.volume_db {
        set_object_field(params, "volume", CanonicalValue::Number(volume));
    }
    if let Some(muted) = element.muted {
        set_object_field(params, "muted", CanonicalValue::Boolean(muted));
    }
    let Some(reframe) = &element.reframe else {
        return;
    };
    if let Some(mode) = &reframe.mode {
        set_object_field(params, "reframe.mode", CanonicalValue::String(mode.clone()));
    }
    if let Some(crop) = &reframe.crop {
        write_rect(params, "reframe.crop", crop);
    }
    if let Some(focal) = &reframe.focal_point {
        set_object_field(params, "reframe.focalX", CanonicalValue::Number(focal.x));
        set_object_field(params, "reframe.focalY", CanonicalValue::Number(focal.y));
    }
    if let Some(target) = &reframe.target_rect {
        write_rect(params, "reframe.target", target);
    }
}

fn write_rect(params: &mut CanonicalValue, prefix: &str, rect: &crate::Rect) {
    set_object_field(
        params,
        &format!("{prefix}X"),
        CanonicalValue::Number(rect.x),
    );
    set_object_field(
        params,
        &format!("{prefix}Y"),
        CanonicalValue::Number(rect.y),
    );
    set_object_field(
        params,
        &format!("{prefix}Width"),
        CanonicalValue::Number(rect.width),
    );
    set_object_field(
        params,
        &format!("{prefix}Height"),
        CanonicalValue::Number(rect.height),
    );
}

fn canonical_effects(active: &[Effect], existing: &[CanonicalEffect]) -> Vec<CanonicalEffect> {
    let old: BTreeMap<_, _> = existing.iter().map(|e| (&e.id, e)).collect();
    active
        .iter()
        .enumerate()
        .map(|(order, effect)| CanonicalEffect {
            order,
            id: effect.effect_id.clone(),
            effect_type: effect.effect_type.clone(),
            enabled: effect.enabled,
            params: old
                .get(&effect.effect_id)
                .filter(|existing| scalar_params(&existing.params) == effect.params)
                .map(|existing| existing.params.clone())
                .unwrap_or_else(|| scalar_object(&effect.params)),
        })
        .collect()
}

fn canonical_masks(active: &[Mask], existing: &[CanonicalMask]) -> Vec<CanonicalMask> {
    let old: BTreeMap<_, _> = existing.iter().map(|mask| (&mask.id, mask)).collect();
    active
        .iter()
        .enumerate()
        .map(|(order, mask)| CanonicalMask {
            order,
            id: mask.mask_id.clone(),
            mask_type: mask.mask_type.clone(),
            params: old
                .get(&mask.mask_id)
                .filter(|existing| mask_params(&existing.params) == mask.params)
                .map(|existing| existing.params.clone())
                .unwrap_or_else(|| mask_object(&mask.params)),
        })
        .collect()
}

fn active_effect(effect: &CanonicalEffect) -> Effect {
    Effect {
        effect_id: effect.id.clone(),
        effect_type: effect.effect_type.clone(),
        enabled: effect.enabled,
        params: scalar_params(&effect.params),
    }
}
fn active_mask(mask: &CanonicalMask) -> Mask {
    Mask {
        mask_id: mask.id.clone(),
        mask_type: mask.mask_type.clone(),
        params: mask_params(&mask.params),
    }
}

fn parse_keyframes(animations: &CanonicalValue) -> Vec<Keyframe> {
    let CanonicalValue::Object(properties) = animations else {
        return vec![];
    };
    let mut keyframes = Vec::new();
    for (property_path, channel) in properties {
        parse_channel_keyframes(property_path, channel, &mut keyframes);
    }
    keyframes
}

fn parse_channel_keyframes(
    property_path: &str,
    channel: &CanonicalValue,
    output: &mut Vec<Keyframe>,
) {
    let CanonicalValue::Object(object) = channel else {
        return;
    };
    if let Some(CanonicalValue::Array(keys)) = object.get("keys") {
        for key in keys {
            let CanonicalValue::Object(key) = key else {
                continue;
            };
            let Some(CanonicalValue::String(id)) = key.get("id") else {
                continue;
            };
            let Some(time) = canonical_ticks(key.get("time")) else {
                continue;
            };
            let Some(value) = key.get("value").and_then(scalar) else {
                continue;
            };
            let interpolation = match key.get("segmentToNext") {
                Some(CanonicalValue::String(value)) if value == "step" => "hold",
                Some(CanonicalValue::String(value)) if value == "bezier" => "bezier",
                _ => "linear",
            };
            output.push(Keyframe {
                keyframe_id: id.clone(),
                property_path: property_path.into(),
                time: MediaTime::from_ticks(time),
                value,
                interpolation: interpolation.into(),
                left_handle: parse_keyframe_handle(key.get("leftHandle")),
                right_handle: parse_keyframe_handle(key.get("rightHandle")),
                tangent_mode: match key.get("tangentMode") {
                    Some(CanonicalValue::String(value)) => Some(value.clone()),
                    _ => None,
                },
            });
        }
        return;
    }
    for (component, value) in object {
        parse_channel_keyframes(&format!("{property_path}.{component}"), value, output);
    }
}

fn sync_keyframes(animations: &mut CanonicalValue, keyframes: &[Keyframe]) {
    if !matches!(animations, CanonicalValue::Object(_)) {
        *animations = CanonicalValue::Object(BTreeMap::new());
    }
    let CanonicalValue::Object(properties) = animations else {
        unreachable!();
    };
    let paths: BTreeMap<String, Vec<&Keyframe>> =
        keyframes
            .iter()
            .fold(BTreeMap::new(), |mut grouped, keyframe| {
                grouped
                    .entry(keyframe.property_path.clone())
                    .or_default()
                    .push(keyframe);
                grouped
            });
    let existing_paths = animation_leaf_paths(properties);
    for (path, storage_key, component) in existing_paths {
        if !paths.contains_key(&path) {
            remove_animation_channel(properties, &storage_key, component.as_deref());
        }
    }
    for (path, mut keys) in paths {
        keys.sort_by_key(|key| (key.time, key.keyframe_id.clone()));
        let (storage_key, component) = animation_channel_location(properties, &path);
        let existing_channel =
            get_animation_channel(properties, &storage_key, component.as_deref());
        let existing_keys = existing_channel
            .and_then(channel_keys_by_id)
            .unwrap_or_default();
        let values = keys
            .into_iter()
            .map(|key| {
                let mut value = existing_keys
                    .get(key.keyframe_id.as_str())
                    .cloned()
                    .unwrap_or_else(|| CanonicalValue::Object(BTreeMap::new()));
                set_object_field(
                    &mut value,
                    "id",
                    CanonicalValue::String(key.keyframe_id.clone()),
                );
                set_object_field(
                    &mut value,
                    "time",
                    CanonicalValue::Integer(key.time.as_ticks()),
                );
                let preserves_value = match &value {
                    CanonicalValue::Object(object) => {
                        object.get("value").and_then(scalar).as_ref() == Some(&key.value)
                    }
                    _ => false,
                };
                if !preserves_value {
                    set_object_field(&mut value, "value", canonical_scalar(&key.value));
                }
                if matches!(key.value, Scalar::Number(_)) {
                    set_object_field(
                        &mut value,
                        "segmentToNext",
                        CanonicalValue::String(
                            match key.interpolation.as_str() {
                                "hold" => "step",
                                "bezier" => "bezier",
                                _ => "linear",
                            }
                            .into(),
                        ),
                    );
                    if let CanonicalValue::Object(object) = &mut value {
                        object.insert(
                            "tangentMode".into(),
                            CanonicalValue::String(
                                key.tangent_mode.clone().unwrap_or_else(|| "flat".into()),
                            ),
                        );
                        sync_keyframe_handle(object, "leftHandle", key.left_handle);
                        sync_keyframe_handle(object, "rightHandle", key.right_handle);
                    }
                }
                value
            })
            .collect();
        let mut channel = existing_channel
            .cloned()
            .unwrap_or_else(|| CanonicalValue::Object(BTreeMap::new()));
        set_object_field(&mut channel, "keys", CanonicalValue::Array(values));
        set_animation_channel(properties, &storage_key, component.as_deref(), channel);
    }
}

fn parse_keyframe_handle(value: Option<&CanonicalValue>) -> Option<crate::KeyframeHandle> {
    let CanonicalValue::Object(handle) = value? else {
        return None;
    };
    let dt = canonical_ticks(handle.get("dt"))?;
    let dv = match handle.get("dv") {
        Some(CanonicalValue::Integer(value)) => *value as f64,
        Some(CanonicalValue::Unsigned(value)) => *value as f64,
        Some(CanonicalValue::Number(value)) if value.is_finite() => *value,
        _ => return None,
    };
    Some(crate::KeyframeHandle {
        dt: MediaTime::from_ticks(dt),
        dv,
    })
}

fn sync_keyframe_handle(
    object: &mut BTreeMap<String, CanonicalValue>,
    field: &str,
    handle: Option<crate::KeyframeHandle>,
) {
    if let Some(handle) = handle {
        object.insert(
            field.into(),
            CanonicalValue::Object(BTreeMap::from([
                ("dt".into(), CanonicalValue::Integer(handle.dt.as_ticks())),
                ("dv".into(), CanonicalValue::Number(handle.dv)),
            ])),
        );
    } else {
        object.remove(field);
    }
}

fn animation_leaf_paths(
    properties: &BTreeMap<String, CanonicalValue>,
) -> Vec<(String, String, Option<String>)> {
    let mut paths = Vec::new();
    for (storage_key, data) in properties {
        if is_leaf_channel(Some(data)) {
            paths.push((storage_key.clone(), storage_key.clone(), None));
            continue;
        }
        let CanonicalValue::Object(components) = data else {
            continue;
        };
        for (component, channel) in components {
            if is_leaf_channel(Some(channel)) {
                paths.push((
                    format!("{storage_key}.{component}"),
                    storage_key.clone(),
                    Some(component.clone()),
                ));
            }
        }
    }
    paths
}

fn animation_channel_location(
    properties: &BTreeMap<String, CanonicalValue>,
    path: &str,
) -> (String, Option<String>) {
    if is_leaf_channel(properties.get(path)) {
        return (path.into(), None);
    }
    let mut candidates = properties
        .iter()
        .filter_map(|(storage_key, data)| {
            let component = path.strip_prefix(&format!("{storage_key}."))?;
            let CanonicalValue::Object(components) = data else {
                return None;
            };
            is_leaf_channel(components.get(component))
                .then(|| (storage_key.clone(), Some(component.to_owned())))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(storage_key, _)| storage_key.len());
    candidates.pop().unwrap_or_else(|| (path.into(), None))
}

fn get_animation_channel<'a>(
    properties: &'a BTreeMap<String, CanonicalValue>,
    storage_key: &str,
    component: Option<&str>,
) -> Option<&'a CanonicalValue> {
    let data = properties.get(storage_key)?;
    match component {
        None => Some(data),
        Some(component) => match data {
            CanonicalValue::Object(components) => components.get(component),
            _ => None,
        },
    }
}

fn set_animation_channel(
    properties: &mut BTreeMap<String, CanonicalValue>,
    storage_key: &str,
    component: Option<&str>,
    channel: CanonicalValue,
) {
    if let Some(component) = component {
        let data = properties
            .entry(storage_key.into())
            .or_insert_with(|| CanonicalValue::Object(BTreeMap::new()));
        if let CanonicalValue::Object(components) = data {
            components.insert(component.into(), channel);
        }
    } else {
        properties.insert(storage_key.into(), channel);
    }
}

fn remove_animation_channel(
    properties: &mut BTreeMap<String, CanonicalValue>,
    storage_key: &str,
    component: Option<&str>,
) {
    let Some(component) = component else {
        properties.remove(storage_key);
        return;
    };
    let should_remove_storage =
        if let Some(CanonicalValue::Object(components)) = properties.get_mut(storage_key) {
            components.remove(component);
            components.is_empty()
        } else {
            false
        };
    if should_remove_storage {
        properties.remove(storage_key);
    }
}

fn is_leaf_channel(value: Option<&CanonicalValue>) -> bool {
    matches!(value, Some(CanonicalValue::Object(object)) if object.contains_key("keys"))
}

fn channel_keys_by_id(value: &CanonicalValue) -> Option<BTreeMap<&str, CanonicalValue>> {
    let CanonicalValue::Object(channel) = value else {
        return None;
    };
    let Some(CanonicalValue::Array(keys)) = channel.get("keys") else {
        return None;
    };
    Some(
        keys.iter()
            .filter_map(|key| {
                let CanonicalValue::Object(object) = key else {
                    return None;
                };
                let Some(CanonicalValue::String(id)) = object.get("id") else {
                    return None;
                };
                Some((id.as_str(), key.clone()))
            })
            .collect(),
    )
}

fn canonical_ticks(value: Option<&CanonicalValue>) -> Option<i64> {
    match value {
        Some(CanonicalValue::Integer(value)) => Some(*value),
        Some(CanonicalValue::Unsigned(value)) => i64::try_from(*value).ok(),
        Some(CanonicalValue::Number(value)) if value.fract() == 0.0 => Some(*value as i64),
        _ => None,
    }
}

fn compound_tracks(
    members: &[Element],
    metadata: &[Track],
    transitions: &[Transition],
    empty_main_track_id: Option<&str>,
    time_origin: MediaTime,
) -> Vec<CanonicalTrack> {
    let mut track_ids = Vec::<String>::new();
    for member in members {
        if !track_ids.contains(&member.track_id) {
            track_ids.push(member.track_id.clone());
        }
    }
    let mut tracks: Vec<_> = track_ids
        .into_iter()
        .enumerate()
        .map(|(order, id)| {
            let mut elements: Vec<_> = members
                .iter()
                .filter(|m| m.track_id == id)
                .enumerate()
                .map(|(element_order, element)| canonical_element(element, element_order, None))
                .collect();
            for element in &mut elements {
                element.common_mut().start_time = MediaTime::from_ticks(
                    element.common().start_time.as_ticks() - time_origin.as_ticks(),
                );
            }
            let existing = metadata.iter().find(|track| track.track_id == id);
            let kind = existing
                .map(|track| track.track_type.as_str())
                .unwrap_or_else(|| {
                    members
                        .iter()
                        .find(|member| member.track_id == id)
                        .map(|member| match member.element_type.as_str() {
                            "audio" => "audio",
                            "text" => "text",
                            "sticker" | "graphic" => "graphic",
                            "effect" => "effect",
                            _ => "video",
                        })
                        .unwrap_or("video")
                });
            let canonical_transitions = transitions
                .iter()
                .filter(|transition| transition.track_id == id)
                .enumerate()
                .map(|(transition_order, transition)| CanonicalTransition {
                    order: transition_order,
                    id: transition.transition_id.clone(),
                    from_element_id: transition.from_element_id.clone(),
                    to_element_id: transition.to_element_id.clone(),
                    transition_type: transition.transition_type.clone(),
                    duration: transition.duration,
                })
                .collect();
            CanonicalTrack {
                role: existing.map(|track| track.role.clone()).unwrap_or_else(|| {
                    if order == 0 && kind == "video" {
                        "main".into()
                    } else if kind == "audio" {
                        "audio".into()
                    } else {
                        "overlay".into()
                    }
                }),
                order,
                id,
                name: existing
                    .map(|track| track.name.clone())
                    .unwrap_or_else(|| "Compound track".into()),
                track_type: kind.into(),
                muted: existing.and_then(|track| track.muted).or(Some(false)),
                hidden: existing.and_then(|track| track.hidden).or(Some(false)),
                transitions: canonical_transitions,
                elements,
            }
        })
        .collect();
    if tracks.iter().all(|track| track.role != "main") {
        tracks.insert(
            0,
            CanonicalTrack {
                role: "main".into(),
                order: 0,
                id: empty_main_track_id
                    .unwrap_or("missing-empty-main-track-id")
                    .into(),
                name: "Video track".into(),
                track_type: "video".into(),
                muted: Some(false),
                hidden: Some(false),
                transitions: vec![],
                elements: vec![],
            },
        );
    }
    normalize_track_orders(&mut tracks);
    tracks
}

fn normalize_track_orders(tracks: &mut [CanonicalTrack]) {
    let mut overlay = 0;
    let mut audio = 0;
    for track in tracks {
        track.order = match track.role.as_str() {
            "main" => 0,
            "audio" => {
                let value = audio;
                audio += 1;
                value
            }
            _ => {
                let value = overlay;
                overlay += 1;
                value
            }
        };
        for (order, element) in track.elements.iter_mut().enumerate() {
            element.common_mut().order = order;
        }
        for (order, transition) in track.transitions.iter_mut().enumerate() {
            transition.order = order;
        }
    }
}

fn role_order(track: &Track, fallback: usize) -> usize {
    if track.role == "main" { 0 } else { fallback }
}

fn read_retime(value: &CanonicalValue, element: &mut Element) {
    let CanonicalValue::Object(map) = value else {
        return;
    };
    element.retime_rate = scalar_number_from(map.get("rate"));
    element.maintain_pitch = scalar_bool_from(map.get("maintainPitch"));
}
fn write_retime(mut value: CanonicalValue, element: &Element) -> CanonicalValue {
    let Some(rate) = element.retime_rate else {
        return value;
    };
    if !matches!(value, CanonicalValue::Object(_)) {
        value = CanonicalValue::Object(BTreeMap::new());
    }
    let preserves_rate = match &value {
        CanonicalValue::Object(object) => scalar_number_from(object.get("rate")) == Some(rate),
        _ => false,
    };
    if !preserves_rate {
        set_object_field(&mut value, "rate", CanonicalValue::Number(rate));
    }
    if let Some(pitch) = element.maintain_pitch {
        set_object_field(&mut value, "maintainPitch", CanonicalValue::Boolean(pitch));
    }
    value
}
fn update_attachment(
    mut attachment: Option<Box<crate::CanonicalAttachment>>,
    enabled: Option<bool>,
) -> Option<Box<crate::CanonicalAttachment>> {
    match enabled {
        None => None,
        Some(value) => {
            if let Some(a) = &mut attachment {
                a.enabled = value;
            }
            attachment
        }
    }
}

fn scalar_params(value: &CanonicalValue) -> Params {
    let CanonicalValue::Object(map) = value else {
        return Params::new();
    };
    map.iter()
        .filter_map(|(key, value)| scalar(value).map(|value| (key.clone(), value)))
        .collect()
}

fn mask_params(value: &CanonicalValue) -> MaskParams {
    let CanonicalValue::Object(map) = value else {
        return MaskParams::new();
    };
    map.iter()
        .filter_map(|(key, value)| mask_param(value).map(|value| (key.clone(), value)))
        .collect()
}

fn mask_param(value: &CanonicalValue) -> Option<MaskParamValue> {
    match value {
        CanonicalValue::String(value) => Some(MaskParamValue::String(value.clone())),
        CanonicalValue::Number(value) => Some(MaskParamValue::Number(*value)),
        CanonicalValue::Integer(value) => Some(MaskParamValue::Number(*value as f64)),
        CanonicalValue::Unsigned(value) => Some(MaskParamValue::Number(*value as f64)),
        CanonicalValue::Boolean(value) => Some(MaskParamValue::Boolean(*value)),
        CanonicalValue::Array(values) => values
            .iter()
            .map(freeform_path_point)
            .collect::<Option<Vec<_>>>()
            .map(MaskParamValue::Path),
        _ => None,
    }
}

fn freeform_path_point(value: &CanonicalValue) -> Option<FreeformPathPoint> {
    let CanonicalValue::Object(point) = value else {
        return None;
    };
    Some(FreeformPathPoint {
        id: match point.get("id") {
            Some(CanonicalValue::String(value)) => value.clone(),
            _ => return None,
        },
        x: scalar_number_from(point.get("x"))?,
        y: scalar_number_from(point.get("y"))?,
        in_x: scalar_number_from(point.get("inX"))?,
        in_y: scalar_number_from(point.get("inY"))?,
        out_x: scalar_number_from(point.get("outX"))?,
        out_y: scalar_number_from(point.get("outY"))?,
    })
}

fn mask_object(params: &MaskParams) -> CanonicalValue {
    CanonicalValue::Object(
        params
            .iter()
            .map(|(key, value)| (key.clone(), canonical_mask_param(value)))
            .collect(),
    )
}

fn canonical_mask_param(value: &MaskParamValue) -> CanonicalValue {
    match value {
        MaskParamValue::String(value) => CanonicalValue::String(value.clone()),
        MaskParamValue::Number(value) => CanonicalValue::Number(*value),
        MaskParamValue::Boolean(value) => CanonicalValue::Boolean(*value),
        MaskParamValue::Path(points) => CanonicalValue::Array(
            points
                .iter()
                .map(|point| {
                    CanonicalValue::Object(BTreeMap::from([
                        ("id".into(), CanonicalValue::String(point.id.clone())),
                        ("x".into(), CanonicalValue::Number(point.x)),
                        ("y".into(), CanonicalValue::Number(point.y)),
                        ("inX".into(), CanonicalValue::Number(point.in_x)),
                        ("inY".into(), CanonicalValue::Number(point.in_y)),
                        ("outX".into(), CanonicalValue::Number(point.out_x)),
                        ("outY".into(), CanonicalValue::Number(point.out_y)),
                    ]))
                })
                .collect(),
        ),
    }
}

pub(crate) fn scalar_params_for_evaluation(value: &CanonicalValue) -> Params {
    scalar_params(value)
}

pub(crate) fn source_audio_params(value: &CanonicalValue) -> CanonicalValue {
    let CanonicalValue::Object(params) = value else {
        return CanonicalValue::Object(BTreeMap::new());
    };
    CanonicalValue::Object(
        params
            .iter()
            .filter(|(key, _)| matches!(key.as_str(), "volume" | "muted"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

pub(crate) fn separated_audio_source(element: &Element) -> Option<CanonicalElement> {
    let CanonicalElement::Video {
        common,
        media_id,
        retime,
        audio_replacement,
        ..
    } = element.canonical_source.as_ref()?
    else {
        return None;
    };
    Some(CanonicalElement::Audio {
        common: common.clone(),
        source_type: "upload".into(),
        media_id: Some(media_id.clone()),
        source_url: None,
        retime: retime.clone(),
        audio_replacement: audio_replacement.clone(),
    })
}

fn scalar_object(params: &Params) -> CanonicalValue {
    CanonicalValue::Object(
        params
            .iter()
            .map(|(k, v)| (k.clone(), canonical_scalar(v)))
            .collect(),
    )
}
fn merge_scalar_params(target: &mut CanonicalValue, params: &Params) {
    for (key, value) in params {
        if let CanonicalValue::Object(current) = target
            && current.get(key).and_then(scalar).as_ref() == Some(value)
        {
            continue;
        }
        set_object_field(target, key, canonical_scalar(value));
    }
}
fn canonical_scalar(value: &Scalar) -> CanonicalValue {
    match value {
        Scalar::String(v) => CanonicalValue::String(v.clone()),
        Scalar::Number(v) => CanonicalValue::Number(*v),
        Scalar::Boolean(v) => CanonicalValue::Boolean(*v),
    }
}
fn scalar(value: &CanonicalValue) -> Option<Scalar> {
    match value {
        CanonicalValue::String(v) => Some(Scalar::String(v.clone())),
        CanonicalValue::Number(v) => Some(Scalar::Number(*v)),
        CanonicalValue::Integer(v) => Some(Scalar::Number(*v as f64)),
        CanonicalValue::Unsigned(v) => Some(Scalar::Number(*v as f64)),
        CanonicalValue::Boolean(v) => Some(Scalar::Boolean(*v)),
        _ => None,
    }
}
fn scalar_string<'a>(value: &'a CanonicalValue, key: &str) -> Option<&'a str> {
    let CanonicalValue::Object(map) = value else {
        return None;
    };
    match map.get(key) {
        Some(CanonicalValue::String(value)) => Some(value),
        _ => None,
    }
}
fn scalar_number(value: &CanonicalValue, key: &str) -> Option<f64> {
    let CanonicalValue::Object(map) = value else {
        return None;
    };
    scalar_number_from(map.get(key))
}
fn scalar_number_from(value: Option<&CanonicalValue>) -> Option<f64> {
    match value {
        Some(CanonicalValue::Number(v)) => Some(*v),
        Some(CanonicalValue::Integer(v)) => Some(*v as f64),
        Some(CanonicalValue::Unsigned(v)) => Some(*v as f64),
        _ => None,
    }
}
fn scalar_bool(value: &CanonicalValue, key: &str) -> Option<bool> {
    let CanonicalValue::Object(map) = value else {
        return None;
    };
    scalar_bool_from(map.get(key))
}
fn scalar_bool_from(value: Option<&CanonicalValue>) -> Option<bool> {
    match value {
        Some(CanonicalValue::Boolean(v)) => Some(*v),
        _ => None,
    }
}
fn set_object_field(value: &mut CanonicalValue, key: &str, entry: CanonicalValue) {
    if !matches!(value, CanonicalValue::Object(_)) {
        *value = CanonicalValue::Object(BTreeMap::new());
    }
    if let CanonicalValue::Object(map) = value {
        map.insert(key.into(), entry);
    }
}

fn object<'a>(
    value: Option<&'a CanonicalValue>,
    path: &str,
) -> Result<&'a CanonicalObject, EditPlanError> {
    match value {
        Some(CanonicalValue::Object(value)) => Ok(value),
        _ => Err(projection_error(
            ErrorCode::InvalidValue,
            "expected canonical object",
            path,
        )),
    }
}
fn unsigned(value: Option<&CanonicalValue>, path: &str) -> Result<u32, EditPlanError> {
    let value = match value {
        Some(CanonicalValue::Unsigned(value)) => *value,
        Some(CanonicalValue::Integer(value)) if *value >= 0 => *value as u64,
        _ => {
            return Err(projection_error(
                ErrorCode::InvalidValue,
                "expected canonical unsigned integer",
                path,
            ));
        }
    };
    u32::try_from(value)
        .map_err(|_| projection_error(ErrorCode::Bounds, "canonical integer is out of range", path))
}
fn string<'a>(value: Option<&'a CanonicalValue>, path: &str) -> Result<&'a str, EditPlanError> {
    match value {
        Some(CanonicalValue::String(value)) => Ok(value),
        _ => Err(projection_error(
            ErrorCode::InvalidValue,
            "expected canonical string",
            path,
        )),
    }
}
fn projection_error(code: ErrorCode, message: &str, path: &str) -> EditPlanError {
    EditPlanError {
        code,
        message: message.into(),
        operation_index: None,
        path: Some(path.into()),
    }
}

impl CanonicalElement {
    pub(crate) fn common(&self) -> &CanonicalElementCommon {
        match self {
            Self::Audio { common, .. }
            | Self::Video { common, .. }
            | Self::Image { common, .. }
            | Self::Text { common, .. }
            | Self::Sticker { common, .. }
            | Self::Graphic { common, .. }
            | Self::Effect { common, .. }
            | Self::Compound { common, .. } => common,
        }
    }
    pub(crate) fn common_mut(&mut self) -> &mut CanonicalElementCommon {
        match self {
            Self::Audio { common, .. }
            | Self::Video { common, .. }
            | Self::Image { common, .. }
            | Self::Text { common, .. }
            | Self::Sticker { common, .. }
            | Self::Graphic { common, .. }
            | Self::Effect { common, .. }
            | Self::Compound { common, .. } => common,
        }
    }
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Audio { .. } => "audio",
            Self::Video { .. } => "video",
            Self::Image { .. } => "image",
            Self::Text { .. } => "text",
            Self::Sticker { .. } => "sticker",
            Self::Graphic { .. } => "graphic",
            Self::Effect { .. } => "effect",
            Self::Compound { .. } => "compound",
        }
    }
}

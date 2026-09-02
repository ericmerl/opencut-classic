use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::BlendMode;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub clear: CanvasClearDescriptor,
    pub items: Vec<FrameItemDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasClearDescriptor {
    pub color: [f32; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FrameItemDescriptor {
    Layer(LayerDescriptor),
    SceneEffect {
        effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerDescriptor {
    pub texture_id: String,
    pub transform: QuadTransformDescriptor,
    pub opacity: f32,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub effect_pass_groups: Vec<Vec<EffectPassDescriptor>>,
    #[serde(default)]
    pub masks: Vec<LayerMaskDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuadTransformDescriptor {
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
    pub rotation_degrees: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    #[serde(default = "NormalizedRectDescriptor::full")]
    pub source_rect: NormalizedRectDescriptor,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRectDescriptor {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl NormalizedRectDescriptor {
    fn full() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerMaskDescriptor {
    pub texture_id: String,
    pub feather: f32,
    pub inverted: bool,
    #[serde(default)]
    pub channel: MaskChannel,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaskChannel {
    #[default]
    Alpha,
    Red,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPassDescriptor {
    pub shader: String,
    pub uniforms: HashMap<String, EffectUniformValueDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EffectUniformValueDescriptor {
    Number(f32),
    Vector(Vec<f32>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasTextureDescriptor {
    pub id: String,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::{FrameDescriptor, FrameItemDescriptor, MaskChannel};

    #[test]
    fn deserializes_ordered_masks_and_defaults_legacy_channel_to_alpha() {
        let frame: FrameDescriptor = serde_json::from_value(serde_json::json!({
            "width": 2,
            "height": 2,
            "clear": { "color": [0.0, 0.0, 0.0, 0.0] },
            "items": [{
                "type": "layer",
                "textureId": "source",
                "transform": {
                    "centerX": 1.0,
                    "centerY": 1.0,
                    "width": 2.0,
                    "height": 2.0,
                    "rotationDegrees": 0.0,
                    "flipX": false,
                    "flipY": false
                },
                "opacity": 1.0,
                "blendMode": "normal",
                "effectPassGroups": [],
                "masks": [
                    {
                        "textureId": "generated",
                        "feather": 0.0,
                        "inverted": false,
                        "channel": "red"
                    },
                    {
                        "textureId": "authored",
                        "feather": 0.0,
                        "inverted": false
                    }
                ]
            }]
        }))
        .expect("frame descriptor should deserialize");

        let FrameItemDescriptor::Layer(layer) = &frame.items[0] else {
            panic!("expected a layer")
        };
        assert_eq!(layer.masks.len(), 2);
        assert!(matches!(layer.masks[0].channel, MaskChannel::Red));
        assert!(matches!(layer.masks[1].channel, MaskChannel::Alpha));
        assert_eq!(layer.transform.source_rect.x, 0.0);
        assert_eq!(layer.transform.source_rect.width, 1.0);
    }

    #[test]
    fn deserializes_a_normalized_source_crop() {
        let transform: super::QuadTransformDescriptor = serde_json::from_value(serde_json::json!({
            "centerX": 1.0,
            "centerY": 1.0,
            "width": 2.0,
            "height": 2.0,
            "rotationDegrees": 0.0,
            "flipX": false,
            "flipY": false,
            "sourceRect": { "x": 0.25, "y": 0.1, "width": 0.5, "height": 0.8 }
        }))
        .expect("transform should deserialize");

        assert_eq!(transform.source_rect.x, 0.25);
        assert_eq!(transform.source_rect.y, 0.1);
        assert_eq!(transform.source_rect.width, 0.5);
        assert_eq!(transform.source_rect.height, 0.8);
    }
}

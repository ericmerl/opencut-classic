use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LayerKeyDescriptor {
    Chroma {
        key_color: [f32; 3],
        similarity: f32,
        softness: f32,
        spill_suppression: f32,
    },
    Luma {
        low: f32,
        high: f32,
        softness: f32,
        inverted: bool,
    },
}

/// CPU reference for the compositor shader's straight-alpha keying contract.
/// Preview and export both execute the equivalent WGSL path.
pub fn apply_compositing_key(mut rgba: [f32; 4], key: &LayerKeyDescriptor) -> [f32; 4] {
    let key_alpha = match key {
        LayerKeyDescriptor::Chroma {
            key_color,
            similarity,
            softness,
            spill_suppression,
        } => {
            let distance = ((rgba[0] - key_color[0]).powi(2)
                + (rgba[1] - key_color[1]).powi(2)
                + (rgba[2] - key_color[2]).powi(2))
            .sqrt()
                / 3.0_f32.sqrt();
            let alpha = smoothstep(*similarity, similarity + softness, distance);
            let dominant = dominant_channel(*key_color);
            let other = rgba
                .iter()
                .take(3)
                .enumerate()
                .filter(|(index, _)| *index != dominant)
                .map(|(_, value)| *value)
                .fold(0.0_f32, f32::max);
            let spill = (rgba[dominant] - other).max(0.0)
                * spill_suppression.clamp(0.0, 1.0)
                * (1.0 - alpha);
            rgba[dominant] = (rgba[dominant] - spill).max(0.0);
            alpha
        }
        LayerKeyDescriptor::Luma {
            low,
            high,
            softness,
            inverted,
        } => {
            let luma = rgba[0] * 0.2126 + rgba[1] * 0.7152 + rgba[2] * 0.0722;
            let within = if *softness == 0.0 {
                f32::from(luma >= *low && luma <= *high)
            } else {
                smoothstep(low - softness, low + softness, luma)
                    * (1.0 - smoothstep(high - softness, high + softness, luma))
            };
            if *inverted { 1.0 - within } else { within }
        }
    };
    rgba[3] *= key_alpha;
    rgba
}

fn dominant_channel(color: [f32; 3]) -> usize {
    if color[1] >= color[0] && color[1] >= color[2] {
        1
    } else if color[2] >= color[0] {
        2
    } else {
        0
    }
}

fn smoothstep(edge0: f32, edge1: f32, value: f32) -> f32 {
    if edge0 == edge1 {
        return f32::from(value >= edge1);
    }
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

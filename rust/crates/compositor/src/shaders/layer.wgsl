struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct LayerUniforms {
    resolution: vec2f,
    center: vec2f,
    size: vec2f,
    rotation_radians: f32,
    opacity: f32,
    flip_x: f32,
    flip_y: f32,
    source_offset: vec2f,
    source_scale: vec2f,
    _padding: vec2f,
    key_color_kind: vec4f,
    key_params: vec4f,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: LayerUniforms;

fn rotate_inverse(point: vec2f, angle: f32) -> vec2f {
    let c = cos(angle);
    let s = sin(angle);
    return vec2f(
        point.x * c + point.y * s,
        -point.x * s + point.y * c,
    );
}

fn keyed_color(source: vec4f) -> vec4f {
    let kind = uniforms.key_color_kind.w;
    if (kind < 0.5) {
        return source;
    }
    if (kind < 1.5) {
        let key_color = uniforms.key_color_kind.rgb;
        let distance = length(source.rgb - key_color) / sqrt(3.0);
        var alpha = 0.0;
        if (uniforms.key_params.y == 0.0) {
            alpha = select(0.0, 1.0, distance >= uniforms.key_params.x);
        } else {
            alpha = smoothstep(
                uniforms.key_params.x,
                uniforms.key_params.x + uniforms.key_params.y,
                distance,
            );
        }
        var rgb = source.rgb;
        var dominant = 0u;
        if (key_color.g >= key_color.r && key_color.g >= key_color.b) {
            dominant = 1u;
        } else if (key_color.b >= key_color.r) {
            dominant = 2u;
        }
        let other = select(
            max(rgb.r, rgb.g),
            select(max(rgb.r, rgb.b), max(rgb.g, rgb.b), dominant == 0u),
            dominant != 2u,
        );
        let spill = max(rgb[dominant] - other, 0.0)
            * clamp(uniforms.key_params.z, 0.0, 1.0)
            * (1.0 - alpha);
        rgb[dominant] = max(rgb[dominant] - spill, 0.0);
        return vec4f(rgb, source.a * alpha);
    }
    let luma = dot(source.rgb, vec3f(0.2126, 0.7152, 0.0722));
    let low = uniforms.key_params.x;
    let high = uniforms.key_params.y;
    let softness = uniforms.key_params.z;
    var within = 0.0;
    if (softness == 0.0) {
        within = select(0.0, 1.0, luma >= low && luma <= high);
    } else {
        within = smoothstep(low - softness, low + softness, luma)
            * (1.0 - smoothstep(high - softness, high + softness, luma));
    }
    if (uniforms.key_params.w > 0.5) {
        within = 1.0 - within;
    }
    return vec4f(source.rgb, source.a * within);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let pixel = input.tex_coord * uniforms.resolution;
    let local = rotate_inverse(pixel - uniforms.center, uniforms.rotation_radians);

    let uv = vec2f(
        local.x / uniforms.size.x + 0.5,
        local.y / uniforms.size.y + 0.5,
    );

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4f(0.0, 0.0, 0.0, 0.0);
    }

    let local_sample_uv = vec2f(
        select(uv.x, 1.0 - uv.x, uniforms.flip_x > 0.5),
        select(uv.y, 1.0 - uv.y, uniforms.flip_y > 0.5),
    );
    let sample_uv = uniforms.source_offset + local_sample_uv * uniforms.source_scale;
    let color = keyed_color(textureSampleLevel(source_texture, source_sampler, sample_uv, 0.0));
    return vec4f(color.rgb, color.a * uniforms.opacity);
}

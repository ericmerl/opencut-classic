struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    primary: vec4f,
    secondary: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

fn tonal_adjustment(color: vec3f, amount: f32, weight: f32) -> vec3f {
    if amount >= 0.0 {
        return color + ((vec3f(1.0) - color) * amount * weight);
    }
    return color + (color * amount * weight);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    let temperature = uniforms.primary.x / 100.0;
    let tint = uniforms.primary.y / 100.0;
    let saturation = uniforms.primary.z / 100.0;
    let exposure = uniforms.primary.w / 100.0;
    let contrast = uniforms.secondary.x / 100.0;
    let highlights = uniforms.secondary.y / 100.0;
    let shadows = uniforms.secondary.z / 100.0;
    let fade = uniforms.secondary.w / 100.0;

    var color = source.rgb;

    color = color + vec3f(
        temperature * 0.10 + tint * 0.05,
        temperature * 0.02 - tint * 0.08,
        -temperature * 0.10 + tint * 0.05,
    );
    color = color * exp2(exposure * 2.0);

    var luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    let shadow_weight = 1.0 - smoothstep(0.0, 0.55, luminance);
    let highlight_weight = smoothstep(0.45, 1.0, luminance);
    color = tonal_adjustment(color, shadows * 0.65, shadow_weight);
    color = tonal_adjustment(color, highlights * 0.65, highlight_weight);

    color = (color - vec3f(0.5)) * max(0.0, 1.0 + contrast) + vec3f(0.5);
    luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    color = mix(vec3f(luminance), color, max(0.0, 1.0 + saturation));

    if fade >= 0.0 {
        let faded = color * 0.72 + vec3f(0.14);
        color = mix(color, faded, fade);
    } else {
        color = (color - vec3f(0.5)) * (1.0 - fade * 0.5) + vec3f(0.5);
    }

    return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), source.a);
}

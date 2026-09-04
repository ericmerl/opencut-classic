struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct MaskUniforms {
    inverted: f32,
    channel: f32,
    _pad1: f32,
    _pad2: f32,
}

@group(0) @binding(0) var layer_texture: texture_2d<f32>;
@group(0) @binding(1) var layer_sampler: sampler;
@group(1) @binding(0) var mask_texture: texture_2d<f32>;
@group(1) @binding(1) var mask_sampler: sampler;
@group(2) @binding(0) var<uniform> uniforms: MaskUniforms;

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let layer = textureSample(layer_texture, layer_sampler, input.tex_coord);
    let sample = textureSample(mask_texture, mask_sampler, input.tex_coord);
    var mask = sample.a;
    if (uniforms.channel > 1.5) {
        mask = dot(sample.rgb, vec3f(0.2126, 0.7152, 0.0722));
    } else if (uniforms.channel > 0.5) {
        mask = sample.r;
    }
    let alpha = select(mask, 1.0 - mask, uniforms.inverted > 0.5);
    return vec4f(layer.rgb, layer.a * alpha);
}

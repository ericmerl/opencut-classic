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

fn hash21(point: vec2f) -> f32 {
    let mixed = fract(point * vec2f(123.34, 456.21));
    return fract(mixed.x * mixed.y * (mixed.x + mixed.y));
}

fn sample_rgb(uv: vec2f) -> vec3f {
    return textureSample(
        input_texture,
        input_sampler,
        clamp(uv, vec2f(0.0), vec2f(1.0)),
    ).rgb;
}

fn film_frame(uv: vec2f, source: vec4f) -> vec4f {
    let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let border = smoothstep(0.018, 0.055, edge);
    let centered = uv - vec2f(0.5);
    let vignette = 1.0 - smoothstep(0.25, 0.72, length(centered));
    let frame_index = floor(uniforms.primary.z * 96.0);
    let grain = (hash21(floor(uv * uniforms.resolution) + frame_index) - 0.5) * 0.075;
    let scratch_x = hash21(vec2f(frame_index, 17.0));
    let scratch = 1.0 - smoothstep(0.001, 0.004, abs(uv.x - scratch_x));
    let rgb = source.rgb * mix(0.68, 1.0, vignette) * border
        + vec3f(grain + scratch * 0.12);
    return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), source.a);
}

fn technicolor_flash(uv: vec2f, source: vec4f) -> vec4f {
    let phase = uniforms.primary.z * 18.8495559;
    let pulse = 0.55 + 0.45 * sin(phase);
    let channels = vec3f(
        1.0 + 0.48 * pulse,
        1.0 + 0.34 * (0.5 + 0.5 * sin(phase + 2.0943951)),
        1.0 + 0.44 * (0.5 + 0.5 * sin(phase + 4.1887902)),
    );
    return vec4f(clamp(source.rgb * channels + vec3f(0.06 * pulse), vec3f(0.0), vec3f(1.0)), source.a);
}

fn scanner_bar(uv: vec2f, source: vec4f) -> vec4f {
    let scan_y = fract(uniforms.primary.z * 1.35);
    let bar = 1.0 - smoothstep(0.015, 0.055, abs(uv.y - scan_y));
    let cooled = source.rgb * vec3f(0.88, 0.96, 1.05);
    return vec4f(clamp(cooled + vec3f(0.20, 0.58, 0.72) * bar, vec3f(0.0), vec3f(1.0)), source.a);
}

fn glitch(uv: vec2f, source: vec4f) -> vec4f {
    let frame = floor(uniforms.primary.z * 48.0);
    let band = floor(uv.y * 22.0);
    let gate = step(0.62, hash21(vec2f(band, frame)));
    let displacement = (hash21(vec2f(frame, band + 9.0)) - 0.5) * 0.075 * gate;
    let shifted = uv + vec2f(displacement, 0.0);
    let separation = 0.008 + gate * 0.012;
    let rgb = vec3f(
        sample_rgb(shifted + vec2f(separation, 0.0)).r,
        sample_rgb(shifted).g,
        sample_rgb(shifted - vec2f(separation, 0.0)).b,
    );
    let block = step(0.86, hash21(vec2f(floor(uv.x * 10.0), band + frame))) * gate;
    return vec4f(clamp(rgb + vec3f(block * 0.14), vec3f(0.0), vec3f(1.0)), source.a);
}

fn chromatic(uv: vec2f, source: vec4f) -> vec4f {
    let separation = 0.012;
    return vec4f(
        sample_rgb(uv + vec2f(separation, 0.0)).r,
        source.g,
        sample_rgb(uv - vec2f(separation, 0.0)).b,
        source.a,
    );
}

fn dark_night(uv: vec2f, source: vec4f) -> vec4f {
    let center = 1.0 - smoothstep(0.18, 0.75, length(uv - vec2f(0.5)));
    let luminance = dot(source.rgb, vec3f(0.2126, 0.7152, 0.0722));
    let rgb = mix(source.rgb * vec3f(0.22, 0.31, 0.52), vec3f(luminance * 0.48, luminance * 0.58, luminance * 0.82), 0.45);
    return vec4f(clamp(rgb * (0.68 + center * 0.32), vec3f(0.0), vec3f(1.0)), source.a);
}

fn mirror(uv: vec2f, source: vec4f) -> vec4f {
    let mirrored_uv = vec2f(min(uv.x, 1.0 - uv.x), uv.y);
    return vec4f(sample_rgb(mirrored_uv), source.a);
}

fn body_treatment(uv: vec2f, source: vec4f) -> vec4f {
    let centered = (uv - vec2f(0.5)) * vec2f(0.82, 1.0);
    let spotlight = 1.0 - smoothstep(0.12, 0.68, length(centered));
    let contrasted = (source.rgb - vec3f(0.5)) * 1.18 + vec3f(0.5);
    let warm = contrasted * vec3f(1.13, 1.02, 0.88) * (0.72 + 0.38 * spotlight);
    return vec4f(clamp(warm, vec3f(0.0), vec3f(1.0)), source.a);
}

fn meme_treatment(uv: vec2f, source: vec4f) -> vec4f {
    let maximum = max(source.r, max(source.g, source.b));
    let minimum = min(source.r, min(source.g, source.b));
    let saturated = mix(vec3f((maximum + minimum) * 0.5), source.rgb, 1.52);
    let contrasted = (saturated - vec3f(0.5)) * 1.28 + vec3f(0.56);
    let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    let frame = smoothstep(0.018, 0.045, edge);
    return vec4f(clamp(contrasted * (0.72 + 0.28 * frame), vec3f(0.0), vec3f(1.0)), source.a);
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    let mode = uniforms.primary.x;
    var treated = film_frame(input.tex_coord, source);
    if (mode > 0.5 && mode < 1.5) {
        treated = technicolor_flash(input.tex_coord, source);
    } else if (mode < 2.5 && mode > 1.5) {
        treated = scanner_bar(input.tex_coord, source);
    } else if (mode < 3.5 && mode > 2.5) {
        treated = glitch(input.tex_coord, source);
    } else if (mode < 4.5 && mode > 3.5) {
        treated = chromatic(input.tex_coord, source);
    } else if (mode < 5.5 && mode > 4.5) {
        treated = dark_night(input.tex_coord, source);
    } else if (mode < 6.5 && mode > 5.5) {
        treated = mirror(input.tex_coord, source);
    } else if (mode < 7.5 && mode > 6.5) {
        treated = body_treatment(input.tex_coord, source);
    } else if (mode > 7.5) {
        treated = meme_treatment(input.tex_coord, source);
    }
    return mix(source, treated, clamp(uniforms.primary.y, 0.0, 1.0));
}

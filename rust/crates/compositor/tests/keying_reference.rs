use compositor::{LayerKeyDescriptor, apply_compositing_key};

#[test]
fn chroma_key_reference_pixels_include_spill_suppression() {
    let key = LayerKeyDescriptor::Chroma {
        key_color: [0.0, 1.0, 0.0],
        similarity: 0.2,
        softness: 0.1,
        spill_suppression: 1.0,
    };

    assert_eq!(
        apply_compositing_key([0.0, 1.0, 0.0, 1.0], &key),
        [0.0, 0.0, 0.0, 0.0]
    );
    assert_eq!(
        apply_compositing_key([1.0, 0.0, 0.0, 1.0], &key),
        [1.0, 0.0, 0.0, 1.0]
    );
}

#[test]
fn luma_key_reference_pixels_use_the_typed_range_and_inversion() {
    let key = LayerKeyDescriptor::Luma {
        low: 0.25,
        high: 0.75,
        softness: 0.0,
        inverted: false,
    };
    assert_eq!(
        apply_compositing_key([0.5, 0.5, 0.5, 1.0], &key),
        [0.5, 0.5, 0.5, 1.0]
    );
    assert_eq!(
        apply_compositing_key([1.0, 1.0, 1.0, 1.0], &key),
        [1.0, 1.0, 1.0, 0.0]
    );
    let inverted = LayerKeyDescriptor::Luma {
        low: 0.25,
        high: 0.75,
        softness: 0.0,
        inverted: true,
    };
    assert_eq!(
        apply_compositing_key([1.0, 1.0, 1.0, 1.0], &inverted),
        [1.0, 1.0, 1.0, 1.0]
    );
}

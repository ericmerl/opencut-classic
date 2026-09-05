import { describe, expect, test } from "bun:test";
import { textStyleContract } from "opencut-wasm";
import { getBuiltInElementParams } from "./registry";

describe("text effect parameter controls", () => {
	test("derive defaults and ranges from the Rust contract", () => {
		const contract = textStyleContract();
		const params = new Map(
			getBuiltInElementParams({ type: "text" }).map((param) => [
				param.key,
				param,
			]),
		);

		expect(params.get("outline.color")?.default).toBe(
			contract.outline.default.color,
		);
		expect(params.get("outline.width")).toMatchObject({
			default: contract.outline.default.width,
			min: contract.outline.width.min,
			max: contract.outline.width.max,
			step: contract.outline.width.step,
		});
		expect(params.get("shadow.offsetX")).toMatchObject({
			default: contract.shadow.default.offsetX,
			min: contract.shadow.offset.min,
			max: contract.shadow.offset.max,
			step: contract.shadow.offset.step,
		});
		expect(params.get("shadow.blur")).toMatchObject({
			default: contract.shadow.default.blur,
			min: contract.shadow.blur.min,
			max: contract.shadow.blur.max,
			step: contract.shadow.blur.step,
		});
	});
});

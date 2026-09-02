import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { getMaskDefinitionsForMenu, registerDefaultMasks } from "@/masks";
import type { ParamDefinition } from "@/params";
import { STICKER_CATEGORIES } from "@/stickers/categories";
import { searchStickers } from "@/stickers";
import type {
	AutomationParamCatalogEntry,
	AutomationStickerSearchRequest,
	AutomationStickerSearchResult,
	AutomationVisualAssetCatalog,
} from "./types";

function serializeParam(param: ParamDefinition): AutomationParamCatalogEntry {
	return {
		key: param.key,
		label: param.label,
		type: param.type,
		default: param.default,
		keyframable: param.keyframable !== false,
		...(param.type === "number"
			? { min: param.min, max: param.max, step: param.step }
			: {}),
		...(param.type === "select" ? { options: param.options } : {}),
	};
}

export function listVisualAssetCatalog(): AutomationVisualAssetCatalog {
	registerDefaultGraphics();
	registerDefaultMasks();
	return {
		graphics: graphicsRegistry.getAll().map((definition) => ({
			definitionId: definition.id,
			name: definition.name,
			keywords: definition.keywords,
			params: definition.params.map(serializeParam),
		})),
		masks: getMaskDefinitionsForMenu().map((definition) => ({
			maskType: definition.type,
			name: definition.name,
			features: definition.features,
			params: [
				...definition.params.map(serializeParam),
				{
					key: "inverted",
					label: "Inverted",
					type: "boolean",
					default: false,
					keyframable: false,
				},
				{
					key: "strokeAlign",
					label: "Stroke align",
					type: "select",
					default: "center",
					keyframable: false,
					options: [
						{ value: "inside", label: "Inside" },
						{ value: "center", label: "Center" },
						{ value: "outside", label: "Outside" },
					],
				},
			],
			supportsFreeformPath: definition.type === "freeform",
		})),
		stickerCategories: Object.entries(STICKER_CATEGORIES).map(([id, name]) => ({
			id,
			name,
		})),
	};
}

export async function searchAutomationStickers(
	request: AutomationStickerSearchRequest,
): Promise<AutomationStickerSearchResult> {
	const result = await searchStickers(request);
	return {
		items: result.items.map((item) => ({
			stickerId: item.id,
			provider: item.provider,
			name: item.name,
			previewUrl: item.previewUrl,
			metadata: item.metadata,
		})),
		total: result.total,
		hasMore: result.hasMore,
	};
}

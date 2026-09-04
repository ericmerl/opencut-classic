export const CORNER_RADIUS_MIN = 0;
export const CORNER_RADIUS_MAX = 100;

export interface TextBackground {
	enabled: boolean;
	color: string;
	/** Draw one bubble per wrapped line instead of one block behind all lines. */
	perLine?: boolean;
	cornerRadius?: number;
	paddingX?: number;
	paddingY?: number;
	offsetX?: number;
	offsetY?: number;
}

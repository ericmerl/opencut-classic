export type NormalizationLimit =
	| "target_loudness"
	| "true_peak_ceiling"
	| "max_gain"
	| "volume_bounds";

export function calculateNormalizationGain({
	integratedLufs,
	estimatedTruePeakDbtp,
	targetLufs,
	maxTruePeakDbtp,
	maxGainDb,
	minimumGainDb,
	maximumGainDb,
}: {
	integratedLufs: number;
	estimatedTruePeakDbtp: number;
	targetLufs: number;
	maxTruePeakDbtp: number;
	maxGainDb: number;
	minimumGainDb: number;
	maximumGainDb: number;
}): { appliedGainDb: number; limitedBy: NormalizationLimit } {
	const targetGainDb = targetLufs - integratedLufs;
	const peakGainDb = maxTruePeakDbtp - estimatedTruePeakDbtp;
	let appliedGainDb = targetGainDb;
	let limitedBy: NormalizationLimit = "target_loudness";
	for (const limit of [
		{ value: peakGainDb, reason: "true_peak_ceiling" as const },
		{ value: maxGainDb, reason: "max_gain" as const },
		{ value: maximumGainDb, reason: "volume_bounds" as const },
	]) {
		if (limit.value < appliedGainDb) {
			appliedGainDb = limit.value;
			limitedBy = limit.reason;
		}
	}
	const lowerBound = Math.max(-60, minimumGainDb);
	if (appliedGainDb < lowerBound) {
		appliedGainDb = lowerBound;
		limitedBy = "volume_bounds";
	}
	return { appliedGainDb, limitedBy };
}

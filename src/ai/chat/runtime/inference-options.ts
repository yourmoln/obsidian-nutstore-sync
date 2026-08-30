function isValidTokenLimit(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

export function resolveMaxOutputTokens(
	sessionMaxTokens: number | undefined,
	modelOutputLimit: number | undefined,
): number | undefined {
	if (isValidTokenLimit(sessionMaxTokens)) return sessionMaxTokens
	if (isValidTokenLimit(modelOutputLimit)) return modelOutputLimit
	return undefined
}

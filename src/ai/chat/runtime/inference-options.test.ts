import { describe, expect, it } from 'vitest'
import { resolveMaxOutputTokens } from '~/ai/chat/runtime/inference-options'

describe('resolveMaxOutputTokens', () => {
	it('prefers a valid explicit session limit', () => {
		expect(resolveMaxOutputTokens(16_000, 384_000)).toBe(16_000)
	})

	it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'falls back to the model limit for invalid session value %s',
		(sessionLimit) => {
			expect(resolveMaxOutputTokens(sessionLimit, 384_000)).toBe(384_000)
		},
	)

	it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'omits invalid model limit %s',
		(modelLimit) => {
			expect(resolveMaxOutputTokens(undefined, modelLimit)).toBeUndefined()
		},
	)
})

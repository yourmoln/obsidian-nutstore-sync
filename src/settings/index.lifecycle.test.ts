import { describe, expect, it, vi } from 'vitest'
import logger from '~/utils/logger'
import { NutstoreSettingTab } from '.'

describe('NutstoreSettingTab lifecycle', () => {
	it('uses hide to flush child settings and handles asynchronous failures', async () => {
		const error = new Error('account cleanup failed')
		const accountHide = vi.fn().mockRejectedValue(error)
		const troubleshootingHide = vi.fn().mockResolvedValue(undefined)
		const loggerError = vi
			.spyOn(logger, 'error')
			.mockImplementation(() => undefined)
		const tab = Object.create(
			NutstoreSettingTab.prototype,
		) as NutstoreSettingTab
		Object.assign(tab, {
			accountSettings: { hide: accountHide },
			troubleshootingSettings: { hide: troubleshootingHide },
		})

		const result = tab.hide()

		expect(result).toBeUndefined()
		expect(accountHide).toHaveBeenCalledOnce()
		expect(troubleshootingHide).toHaveBeenCalledOnce()
		await vi.waitFor(() =>
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to hide settings tab:',
				error,
			),
		)
	})
})

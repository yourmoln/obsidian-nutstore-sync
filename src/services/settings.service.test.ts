import { describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import { DEFAULT_LOG_DIRECTORY } from '~/utils/log-note'
import SettingsService from './settings.service'

function createPlugin(logDirectory: unknown, configDir = '.obsidian') {
	return {
		app: { vault: { configDir } },
		loadData: vi.fn().mockResolvedValue({ logDirectory }),
		saveData: vi.fn(),
	} as unknown as NutstorePlugin
}

describe('SettingsService log directory loading', () => {
	it.each([
		['number', 42],
		['array', []],
		['object', {}],
	] as const)(
		'recovers from a persisted non-string %s',
		async (_type, value) => {
			const plugin = createPlugin(value)
			const service = new SettingsService(plugin)

			await expect(service.loadSettings()).resolves.toBeUndefined()

			expect(plugin.settings.logDirectory).toBe(DEFAULT_LOG_DIRECTORY)
		},
	)

	it('rejects a persisted directory inside a custom configDir', async () => {
		const plugin = createPlugin('config/logs', 'config')
		const service = new SettingsService(plugin)

		await service.loadSettings()

		expect(plugin.settings.logDirectory).toBe(DEFAULT_LOG_DIRECTORY)
	})
})

import { describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import { DEFAULT_SETTINGS } from '~/settings'
import { DEFAULT_LOG_DIRECTORY } from '~/utils/log-note'
import SettingsService from './settings.service'

function createPlugin(logDirectory: unknown, configDir = '.obsidian') {
	return {
		app: { vault: { configDir, adapter: {} } },
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

	it('persists overrides without running post-save side effects', async () => {
		const saveData = vi.fn().mockResolvedValue(undefined)
		const handleSettingsChanged = vi
			.fn()
			.mockRejectedValue(new Error('chat refresh failed'))
		const refresh = vi.fn().mockRejectedValue(new Error('AI refresh failed'))
		const plugin = {
			settings: { ...DEFAULT_SETTINGS },
			saveData,
			chatService: { handleSettingsChanged },
			aiConflictResolverService: { refresh },
		} as unknown as NutstorePlugin
		const service = new SettingsService(plugin)
		const overrides = { logDirectory: 'notes/logs' }

		await expect(service.persistSettings(overrides)).resolves.toBeUndefined()

		expect(saveData).toHaveBeenCalledWith({
			...plugin.settings,
			...overrides,
		})
		expect(handleSettingsChanged).not.toHaveBeenCalled()
		expect(refresh).not.toHaveBeenCalled()
	})

	it('serializes writes and merges queued overrides with current settings', async () => {
		let resolveFirstWrite!: () => void
		const firstWrite = new Promise<void>((resolve) => {
			resolveFirstWrite = resolve
		})
		const saveData = vi
			.fn()
			.mockImplementationOnce(async () => firstWrite)
			.mockResolvedValueOnce(undefined)
		const plugin = {
			settings: { ...DEFAULT_SETTINGS },
			saveData,
		} as unknown as NutstorePlugin
		const service = new SettingsService(plugin)

		const firstPersistence = service.persistSettings({
			logDirectory: 'first/logs',
		})
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce())
		plugin.settings.account = 'latest-account'
		const secondPersistence = service.persistSettings({
			logDirectory: 'second/logs',
		})

		await Promise.resolve()
		expect(saveData).toHaveBeenCalledOnce()
		resolveFirstWrite()
		await Promise.all([firstPersistence, secondPersistence])

		expect(saveData).toHaveBeenCalledTimes(2)
		expect(saveData.mock.calls[0][0]).toMatchObject({
			account: '',
			logDirectory: 'first/logs',
		})
		expect(saveData.mock.calls[1][0]).toMatchObject({
			account: 'latest-account',
			logDirectory: 'second/logs',
		})
	})

	it('continues the persistence queue after a rejected write', async () => {
		const saveData = vi
			.fn()
			.mockRejectedValueOnce(new Error('disk full'))
			.mockResolvedValueOnce(undefined)
		const plugin = {
			settings: { ...DEFAULT_SETTINGS },
			saveData,
		} as unknown as NutstorePlugin
		const service = new SettingsService(plugin)

		const firstPersistence = service.persistSettings({
			logDirectory: 'first/logs',
		})
		const secondPersistence = service.persistSettings({
			logDirectory: 'second/logs',
		})

		await expect(firstPersistence).rejects.toThrow('disk full')
		await expect(secondPersistence).resolves.toBeUndefined()
		expect(saveData).toHaveBeenCalledTimes(2)
		expect(saveData.mock.calls[1][0]).toMatchObject({
			logDirectory: 'second/logs',
		})
	})
})

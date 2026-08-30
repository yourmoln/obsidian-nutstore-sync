import { describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import { DEFAULT_SETTINGS, type NutstoreSettings } from '~/settings'
import { DEFAULT_LOG_DIRECTORY } from '~/utils/log-note'
import SettingsService from './settings.service'

function createDeferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, reject, resolve }
}

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

	it('publishes successful overrides before a queued full save snapshots settings', async () => {
		const firstWrite = createDeferred()
		const saveData = vi
			.fn()
			.mockImplementationOnce(async () => firstWrite.promise)
			.mockResolvedValueOnce(undefined)
		const plugin = {
			settings: { ...DEFAULT_SETTINGS },
			saveData,
		} as unknown as NutstorePlugin
		const service = new SettingsService(plugin)

		const directoryPersistence = service.persistSettings({
			logDirectory: 'notes/logs',
		})
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce())
		plugin.settings.account = 'latest-account'
		const fullPersistence = service.persistSettings()

		firstWrite.resolve()
		await Promise.all([directoryPersistence, fullPersistence])

		expect(plugin.settings.logDirectory).toBe('notes/logs')
		expect(saveData.mock.calls[1][0]).toMatchObject({
			account: 'latest-account',
			logDirectory: 'notes/logs',
		})
	})

	it('waits for rejected and newly queued persistence before reloading settings', async () => {
		const firstWrite = createDeferred()
		const secondWrite = createDeferred()
		const saveData = vi
			.fn()
			.mockImplementationOnce(async () => firstWrite.promise)
			.mockImplementationOnce(async () => secondWrite.promise)
		const loadData = vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS })
		const plugin = {
			app: { vault: { configDir: '.obsidian', adapter: {} } },
			settings: { ...DEFAULT_SETTINGS },
			loadData,
			saveData,
			modelsPresetService: { initializeFromLocalSettings: vi.fn() },
			nutstoreLlmGatewayService: {
				initializeProviderFromStoredAuth: vi.fn(),
			},
			i18nService: { update: vi.fn() },
			chatService: { handleSettingsChanged: vi.fn() },
			aiConflictResolverService: { refresh: vi.fn() },
			scheduledSyncService: { updateInterval: vi.fn() },
			settingTab: { rerenderIfVisible: vi.fn() },
		} as unknown as NutstorePlugin
		const service = new SettingsService(plugin)
		vi.spyOn(service, 'loadLocalSettings').mockResolvedValue()

		const firstPersistence = service.persistSettings({ account: 'first' })
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledOnce())
		const reload = service.reloadSettingsFromDisk()
		const secondPersistence = service.persistSettings({ account: 'second' })

		await Promise.resolve()
		expect(loadData).not.toHaveBeenCalled()
		const firstRejection = expect(firstPersistence).rejects.toThrow('disk full')
		firstWrite.reject(new Error('disk full'))
		await firstRejection
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(2))
		expect(loadData).not.toHaveBeenCalled()

		secondWrite.resolve()
		await Promise.all([secondPersistence, reload])

		expect(loadData).toHaveBeenCalledOnce()
	})

	it('discards a stale disk read when persistence starts during reload', async () => {
		const staleRead = createDeferred<Partial<NutstoreSettings>>()
		let diskSettings: Partial<NutstoreSettings> = {
			...DEFAULT_SETTINGS,
			account: 'disk-before-reload',
		}
		const loadData = vi
			.fn()
			.mockImplementationOnce(() => staleRead.promise)
			.mockImplementation(async () => ({ ...diskSettings }))
		const saveData = vi.fn(async (settings: NutstoreSettings) => {
			diskSettings = { ...settings }
		})
		const plugin = {
			app: { vault: { configDir: '.obsidian', adapter: {} } },
			settings: { ...DEFAULT_SETTINGS, account: 'runtime-before-reload' },
			loadData,
			saveData,
			modelsPresetService: { initializeFromLocalSettings: vi.fn() },
			nutstoreLlmGatewayService: {
				initializeProviderFromStoredAuth: vi.fn(),
			},
			i18nService: { update: vi.fn() },
			chatService: { handleSettingsChanged: vi.fn() },
			aiConflictResolverService: { refresh: vi.fn() },
			scheduledSyncService: { updateInterval: vi.fn() },
			settingTab: { rerenderIfVisible: vi.fn() },
		} as unknown as NutstorePlugin
		const service = new SettingsService(plugin)
		vi.spyOn(service, 'loadLocalSettings').mockResolvedValue()

		const reload = service.reloadSettingsFromDisk()
		await vi.waitFor(() => expect(loadData).toHaveBeenCalledOnce())
		plugin.settings.account = 'local-edit'
		await service.persistSettings()

		staleRead.resolve({
			...DEFAULT_SETTINGS,
			account: 'stale-disk-read',
		})
		await reload

		expect(loadData).toHaveBeenCalledTimes(2)
		expect(saveData).toHaveBeenCalledOnce()
		expect(diskSettings.account).toBe('local-edit')
		expect(plugin.settings.account).toBe('local-edit')
	})
})

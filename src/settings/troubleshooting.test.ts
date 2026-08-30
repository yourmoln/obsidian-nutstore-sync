import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_LOG_DIRECTORY,
	LOG_FILE_NAME_BYTE_BUDGET,
} from '~/utils/log-note'
import TroubleshootingSettings from './troubleshooting'

type MockTextComponent = {
	change(value: string): Promise<void>
	blur(): void
	getValue(): string
}

const ui = vi.hoisted(() => ({
	textComponents: [] as MockTextComponent[],
	notices: [] as string[],
}))
const mockLogger = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('obsidian', async (importOriginal) => {
	const actual = await importOriginal<typeof import('obsidian')>()

	class Setting {
		constructor(_containerEl: unknown) {}

		setName(_name: string) {
			return this
		}

		setDesc(_description: string) {
			return this
		}

		setHeading() {
			return this
		}

		addButton(callback: (button: unknown) => void) {
			const button = {
				setButtonText: () => button,
				setDisabled: () => button,
				onClick: () => button,
			}
			callback(button)
			return this
		}

		addText(callback: (text: unknown) => void) {
			let value = ''
			let changeHandler: ((nextValue: string) => unknown) | undefined
			let blurHandler: (() => unknown) | undefined
			const text = {
				inputEl: {
					addEventListener(event: string, handler: () => unknown) {
						if (event === 'blur') blurHandler = handler
					},
				},
				setPlaceholder: () => text,
				setValue(nextValue: string) {
					value = nextValue
					return text
				},
				getValue: () => value,
				onChange(handler: (nextValue: string) => unknown) {
					changeHandler = handler
					return text
				},
				async change(nextValue: string) {
					value = nextValue
					await changeHandler?.(nextValue)
				},
				blur() {
					void blurHandler?.()
				},
			}
			callback(text)
			ui.textComponents.push(text)
			return this
		}
	}

	class Notice {
		constructor(message: string) {
			ui.notices.push(message)
		}
	}

	return { ...actual, Notice, Setting }
})

vi.mock('~/components/CacheClearModal', () => ({
	default: class {},
}))

vi.mock('~/storage/blob', () => ({
	blobStore: {},
}))

vi.mock('~/i18n', () => ({
	default: {
		t: (key: string) => key,
	},
}))

vi.mock('~/utils/logger', () => ({
	default: mockLogger,
}))

function createDeferred() {
	let resolve!: () => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, reject, resolve }
}

async function flushMicrotasks() {
	for (let index = 0; index < 4; index++) {
		await Promise.resolve()
	}
}

function createSettingsSection(
	persistSettings = vi.fn(async (_settings?: unknown) => undefined),
	saveSettings = persistSettings,
	configDir = '.obsidian',
) {
	const plugin = {
		settings: { logDirectory: 'support/logs' },
		settingsService: { persistSettings, saveSettings },
		loggerService: { logs: [], clear: vi.fn() },
	}
	const section = new TroubleshootingSettings(
		{ vault: { configDir, adapter: {} } } as never,
		plugin as never,
		{} as never,
		{ empty: vi.fn() } as never,
	)
	return { persistSettings, plugin, section }
}

describe('TroubleshootingSettings log notes', () => {
	beforeEach(() => {
		ui.textComponents = []
		ui.notices = []
		mockLogger.error.mockReset()
	})

	it('creates a log note in the configured directory', async () => {
		const create = vi.fn().mockResolvedValue({ path: 'support/logs/log.md' })
		const app = {
			vault: {
				configDir: '.obsidian',
				adapter: {
					exists: vi.fn().mockResolvedValue(true),
					mkdir: vi.fn(),
				},
				create,
			},
			workspace: {
				getLeaf: () => ({ openFile: vi.fn() }),
			},
		}
		const plugin = {
			settings: { logDirectory: 'support/logs' },
			loggerService: { logs: [] },
			manifest: { version: 'test' },
		}
		const section = new TroubleshootingSettings(
			app as never,
			plugin as never,
			{} as never,
			{} as never,
		)

		await (
			section as unknown as { saveLogsToNote(): Promise<void> }
		).saveLogsToNote()

		expect(create).toHaveBeenCalledOnce()
		const createdPath = create.mock.calls[0][0]
		expect(createdPath).toMatch(/^support\/logs\/nutstore-logs-/)
		const fileName = createdPath.slice(createdPath.lastIndexOf('/') + 1)
		expect(new TextEncoder().encode(fileName).byteLength).toBeLessThanOrEqual(
			LOG_FILE_NAME_BYTE_BUDGET,
		)
	})

	it.each([
		[
			'normalizes a valid path',
			' notes\\support//./logs ',
			'notes/support/logs',
			'.obsidian',
		],
		[
			'replaces a hidden path',
			'.obsidian/logs',
			DEFAULT_LOG_DIRECTORY,
			'.obsidian',
		],
		[
			'replaces a custom config path',
			'config/logs',
			DEFAULT_LOG_DIRECTORY,
			'config',
		],
	] as const)(
		'%s when committing the log directory on blur',
		async (_case, input, expected, configDir) => {
			const { persistSettings, plugin, section } = createSettingsSection(
				undefined,
				undefined,
				configDir,
			)

			await section.display()
			const text = ui.textComponents[0]
			expect(text.getValue()).toBe('support/logs')

			await text.change(input)
			expect(plugin.settings.logDirectory).toBe('support/logs')
			expect(persistSettings).not.toHaveBeenCalled()

			text.blur()
			await section.hide()
			expect(text.getValue()).toBe(expected)
			expect(plugin.settings.logDirectory).toBe(expected)
			expect(persistSettings).toHaveBeenCalledOnce()
		},
	)

	it('rolls back the input and runtime setting when persistence fails', async () => {
		const persistSettings = vi.fn().mockRejectedValue(new Error('disk full'))
		const { plugin, section } = createSettingsSection(
			persistSettings,
			persistSettings,
		)

		await section.display()
		const text = ui.textComponents[0]
		await text.change('notes/logs')

		text.blur()
		await expect(section.hide()).resolves.toBeUndefined()

		expect(persistSettings).toHaveBeenCalledOnce()
		expect(text.getValue()).toBe('support/logs')
		expect(plugin.settings.logDirectory).toBe('support/logs')
		expect(ui.notices).toContain('settings.log.directorySaveError')
		expect(mockLogger.error).toHaveBeenCalledWith(
			'Failed to save log directory setting:',
			expect.any(Error),
		)
	})

	it('uses the persistence-only boundary instead of post-save hooks', async () => {
		let diskDirectory = 'support/logs'
		const persistSettings = vi.fn(
			async (settings: { logDirectory: string }) => {
				diskDirectory = settings.logDirectory
			},
		)
		const saveSettings = vi
			.fn()
			.mockRejectedValue(new Error('chat refresh failed'))
		const { plugin, section } = createSettingsSection(
			persistSettings,
			saveSettings,
		)

		await section.display()
		const text = ui.textComponents[0]
		await text.change('notes/logs')
		text.blur()
		await section.hide()

		expect(persistSettings).toHaveBeenCalledOnce()
		expect(saveSettings).not.toHaveBeenCalled()
		expect(diskDirectory).toBe('notes/logs')
		expect(plugin.settings.logDirectory).toBe('notes/logs')
		expect(text.getValue()).toBe('notes/logs')
	})

	it('waits for the directory commit before saving logs to a note', async () => {
		const pendingSave = createDeferred()
		const persistSettings = vi.fn(() => pendingSave.promise)
		const create = vi.fn().mockResolvedValue({ path: 'notes/logs/log.md' })
		const app = {
			vault: {
				configDir: '.obsidian',
				adapter: {
					exists: vi.fn().mockResolvedValue(true),
					mkdir: vi.fn(),
				},
				create,
			},
			workspace: {
				getLeaf: () => ({ openFile: vi.fn() }),
			},
		}
		const plugin = {
			settings: { logDirectory: 'support/logs' },
			settingsService: { persistSettings },
			loggerService: { logs: [], clear: vi.fn() },
			manifest: { version: 'test' },
		}
		const section = new TroubleshootingSettings(
			app as never,
			plugin as never,
			{} as never,
			{ empty: vi.fn() } as never,
		)

		await section.display()
		const text = ui.textComponents[0]
		await text.change('notes/logs')
		text.blur()
		const saveLogs = (
			section as unknown as { saveLogsToNote(): Promise<void> }
		).saveLogsToNote()
		await flushMicrotasks()
		const createCallsBeforeCommit = create.mock.calls.length

		pendingSave.resolve()
		await saveLogs
		await section.hide()

		expect(createCallsBeforeCommit).toBe(0)
		expect(create.mock.calls[0][0]).toMatch(/^notes\/logs\/nutstore-logs-/)
	})

	it('serializes rapid successful blur commits in submission order', async () => {
		const firstSave = createDeferred()
		const secondSave = createDeferred()
		let diskDirectory = 'support/logs'
		const persistSettings = vi.fn((settings: { logDirectory: string }) => {
			const pendingSave =
				persistSettings.mock.calls.length === 1 ? firstSave : secondSave
			return pendingSave.promise.then(() => {
				diskDirectory = settings.logDirectory
			})
		})
		const { plugin, section } = createSettingsSection(persistSettings)

		await section.display()
		const text = ui.textComponents[0]
		await text.change('first/logs')
		text.blur()
		await flushMicrotasks()
		await text.change('second/logs')
		text.blur()
		await flushMicrotasks()

		expect(persistSettings).toHaveBeenCalledOnce()
		firstSave.resolve()
		await flushMicrotasks()
		expect(persistSettings).toHaveBeenCalledTimes(2)
		secondSave.resolve()
		await section.hide()

		expect(
			persistSettings.mock.calls.map(([settings]) => settings.logDirectory),
		).toEqual(['first/logs', 'second/logs'])
		expect(diskDirectory).toBe('second/logs')
		expect(plugin.settings.logDirectory).toBe('second/logs')
		expect(text.getValue()).toBe('second/logs')
	})

	it('does not let a stale failed commit roll back a newer success', async () => {
		const firstSave = createDeferred()
		const secondSave = createDeferred()
		let diskDirectory = 'support/logs'
		const persistSettings = vi.fn((settings: { logDirectory: string }) => {
			const pendingSave =
				persistSettings.mock.calls.length === 1 ? firstSave : secondSave
			return pendingSave.promise.then(() => {
				diskDirectory = settings.logDirectory
			})
		})
		const { plugin, section } = createSettingsSection(persistSettings)

		await section.display()
		const text = ui.textComponents[0]
		await text.change('first/logs')
		text.blur()
		await flushMicrotasks()
		await text.change('second/logs')
		text.blur()
		firstSave.reject(new Error('first write failed'))
		await flushMicrotasks()
		secondSave.resolve()
		await section.hide()

		expect(diskDirectory).toBe('second/logs')
		expect(plugin.settings.logDirectory).toBe('second/logs')
		expect(text.getValue()).toBe('second/logs')
		expect(ui.notices).not.toContain('settings.log.directorySaveError')
	})

	it('rolls the latest failed commit back to the last persisted value', async () => {
		const firstSave = createDeferred()
		const secondSave = createDeferred()
		let diskDirectory = 'support/logs'
		const persistSettings = vi.fn((settings: { logDirectory: string }) => {
			const pendingSave =
				persistSettings.mock.calls.length === 1 ? firstSave : secondSave
			return pendingSave.promise.then(() => {
				diskDirectory = settings.logDirectory
			})
		})
		const { plugin, section } = createSettingsSection(persistSettings)

		await section.display()
		const text = ui.textComponents[0]
		await text.change('first/logs')
		text.blur()
		await flushMicrotasks()
		await text.change('second/logs')
		text.blur()
		firstSave.resolve()
		await flushMicrotasks()
		secondSave.reject(new Error('second write failed'))
		await section.hide()

		expect(diskDirectory).toBe('first/logs')
		expect(plugin.settings.logDirectory).toBe('first/logs')
		expect(text.getValue()).toBe('first/logs')
		expect(ui.notices).toContain('settings.log.directorySaveError')
	})

	it('commits an unblurred edit when the settings page closes', async () => {
		const { persistSettings, plugin, section } = createSettingsSection()

		await section.display()
		const text = ui.textComponents[0]
		await text.change('notes/logs')
		await section.hide()

		expect(persistSettings).toHaveBeenCalledOnce()
		expect(plugin.settings.logDirectory).toBe('notes/logs')
	})

	it('commits the current edit before a programmatic rerender', async () => {
		const { persistSettings, plugin, section } = createSettingsSection()

		await section.display()
		await ui.textComponents[0].change('notes/logs')
		await section.display()
		await section.hide()

		expect(persistSettings).toHaveBeenCalledOnce()
		expect(plugin.settings.logDirectory).toBe('notes/logs')
		expect(ui.textComponents.at(-1)?.getValue()).toBe('notes/logs')
	})

	it('rolls back the visible replacement input after a rerendered save fails', async () => {
		const pendingSave = createDeferred()
		const persistSettings = vi.fn(() => pendingSave.promise)
		const { plugin, section } = createSettingsSection(persistSettings)

		await section.display()
		await ui.textComponents[0].change('notes/logs')
		await section.display()
		const replacementText = ui.textComponents.at(-1)
		expect(replacementText?.getValue()).toBe('notes/logs')

		pendingSave.reject(new Error('disk full'))
		await section.hide()

		expect(plugin.settings.logDirectory).toBe('support/logs')
		expect(replacementText?.getValue()).toBe('support/logs')
		expect(ui.notices).toContain('settings.log.directorySaveError')
	})
})

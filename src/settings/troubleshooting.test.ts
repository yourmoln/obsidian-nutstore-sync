import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOG_DIRECTORY } from '~/utils/log-note'
import TroubleshootingSettings from './troubleshooting'

type MockTextComponent = {
	change(value: string): Promise<void>
	blur(): Promise<void>
	getValue(): string
}

const ui = vi.hoisted(() => ({
	textComponents: [] as MockTextComponent[],
}))

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
				async blur() {
					await blurHandler?.()
				},
			}
			callback(text)
			ui.textComponents.push(text)
			return this
		}
	}

	return { ...actual, Setting }
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
	default: {
		error: vi.fn(),
	},
}))

describe('TroubleshootingSettings log notes', () => {
	beforeEach(() => {
		ui.textComponents = []
	})

	it('creates a log note in the configured directory', async () => {
		const create = vi.fn().mockResolvedValue({ path: 'support/logs/log.md' })
		const app = {
			vault: {
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
		expect(create.mock.calls[0][0]).toMatch(/^support\/logs\/nutstore-logs-/)
	})

	it.each([
		[
			'normalizes a valid path',
			' notes\\support//./logs ',
			'notes/support/logs',
		],
		['replaces a hidden path', '.obsidian/logs', DEFAULT_LOG_DIRECTORY],
	] as const)(
		'%s when committing the log directory on blur',
		async (_case, input, expected) => {
			const saveSettings = vi.fn(async () => undefined)
			const plugin = {
				settings: { logDirectory: 'support/logs' },
				settingsService: { saveSettings },
				loggerService: { logs: [], clear: vi.fn() },
			}
			const section = new TroubleshootingSettings(
				{} as never,
				plugin as never,
				{} as never,
				{ empty: vi.fn() } as never,
			)

			await section.display()
			const text = ui.textComponents[0]
			expect(text.getValue()).toBe('support/logs')

			await text.change(input)
			expect(plugin.settings.logDirectory).toBe('support/logs')
			expect(saveSettings).not.toHaveBeenCalled()

			await text.blur()
			expect(text.getValue()).toBe(expected)
			expect(plugin.settings.logDirectory).toBe(expected)
			expect(saveSettings).toHaveBeenCalledOnce()
		},
	)
})

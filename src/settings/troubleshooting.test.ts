import { describe, expect, it, vi } from 'vitest'
import TroubleshootingSettings from './troubleshooting'

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
})

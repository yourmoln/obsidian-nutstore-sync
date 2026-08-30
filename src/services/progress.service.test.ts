import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	emitEndSync,
	emitPreparingSync,
	emitSyncCancelled,
	emitSyncProgress,
} from '../events'
import { ProgressService } from './progress.service'

const modal = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	update: vi.fn(),
}))

const resultModal = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
}))

vi.mock('../components/SyncProgressModal', () => ({
	default: class {
		open = modal.open
		close = modal.close
		update = modal.update
	},
}))

vi.mock('../components/SyncResultModal', () => ({
	default: class {
		open = resultModal.open
		close = resultModal.close
	},
}))

vi.mock('obsidian', () => ({
	Notice: class {},
}))

describe('ProgressService completion', () => {
	let service: ProgressService
	let plugin: {
		isSyncing: boolean
		settings: { showSyncResultModal?: boolean }
	}

	beforeEach(() => {
		vi.clearAllMocks()
		plugin = {
			isSyncing: true,
			settings: {},
		}
		service = new ProgressService(plugin as never)
		service.onload()
	})

	afterEach(() => {
		service.onunload()
	})

	it('shows a success result by default for visible zero-task progress', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(modal.open).toHaveBeenCalledOnce()
		expect(modal.close).toHaveBeenCalledOnce()
		expect(resultModal.open).toHaveBeenCalledOnce()
	})

	it('replaces visible completed task progress with a success result', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()
		emitSyncProgress(2, [], null)

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(modal.close).toHaveBeenCalledOnce()
		expect(resultModal.open).toHaveBeenCalledOnce()
	})

	it('does not show a result after progress was hidden', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()
		service.closeProgressModal()

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(resultModal.open).not.toHaveBeenCalled()
	})

	it('shows a result when hidden progress was opened again', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()
		service.closeProgressModal()
		service.showProgressModal()

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(resultModal.open).toHaveBeenCalledOnce()
	})

	it('suppresses a successful result when the setting is disabled', () => {
		plugin.settings.showSyncResultModal = false
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(modal.close).toHaveBeenCalledOnce()
		expect(resultModal.open).not.toHaveBeenCalled()
	})

	it('still closes visible progress on cancellation when results are disabled', () => {
		plugin.settings.showSyncResultModal = false
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()

		emitSyncCancelled()

		expect(modal.close).toHaveBeenCalledOnce()
		expect(resultModal.open).not.toHaveBeenCalled()
	})

	it('keeps failed completion visible when success results are disabled', async () => {
		plugin.settings.showSyncResultModal = false
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()

		emitEndSync({ showNotice: true, failedCount: 2 })

		expect(service.syncFailedCount).toBe(2)
		await vi.waitFor(() => expect(modal.update).toHaveBeenCalled())
		expect(modal.close).not.toHaveBeenCalled()
		expect(resultModal.open).not.toHaveBeenCalled()
	})
})

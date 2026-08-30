import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitEndSync, emitPreparingSync } from '../events'
import EventsService from './events.service'
import { ProgressService } from './progress.service'

const progressModal = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	update: vi.fn(),
}))

const resultModal = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
}))

const notice = vi.hoisted(() => vi.fn())

vi.mock('../components/SyncProgressModal', () => ({
	default: class {
		open = progressModal.open
		close = progressModal.close
		update = progressModal.update
	},
}))

vi.mock('../components/SyncResultModal', () => ({
	default: class {
		open = resultModal.open
		close = resultModal.close
	},
}))

vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string) {
			notice(message)
		}
	},
}))

describe('sync completion presentation', () => {
	let eventsService: EventsService
	let progressService: ProgressService
	let plugin: {
		isSyncing: boolean
		settings: { showSyncResultModal: boolean }
		toggleSyncUI: ReturnType<typeof vi.fn>
		statusService: {
			updateSyncStatus: ReturnType<typeof vi.fn>
			setLastSyncTime: ReturnType<typeof vi.fn>
		}
		progressService?: ProgressService
	}

	beforeEach(() => {
		vi.clearAllMocks()
		plugin = {
			isSyncing: true,
			settings: { showSyncResultModal: false },
			toggleSyncUI: vi.fn(),
			statusService: {
				updateSyncStatus: vi.fn(),
				setLastSyncTime: vi.fn(),
			},
		}
		progressService = new ProgressService(plugin as never)
		plugin.progressService = progressService
		eventsService = new EventsService(plugin as never)

		progressService.onload()
		eventsService.onload()
	})

	afterEach(() => {
		eventsService.onunload()
		progressService.onunload()
	})

	it('does not replace a suppressed success result with a notice', () => {
		emitPreparingSync({ showNotice: true })

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(progressModal.close).toHaveBeenCalledOnce()
		expect(resultModal.open).not.toHaveBeenCalled()
		expect(notice).not.toHaveBeenCalled()
	})

	it('keeps failed completion visible when the progress modal is open', async () => {
		emitPreparingSync({ showNotice: true })

		emitEndSync({ showNotice: true, failedCount: 2 })

		expect(progressService.syncFailedCount).toBe(2)
		await vi.waitFor(() => expect(progressModal.update).toHaveBeenCalled())
		expect(progressModal.close).not.toHaveBeenCalled()
		expect(notice).not.toHaveBeenCalled()
	})

	it('still notifies about failed completion when progress was hidden', () => {
		emitPreparingSync({ showNotice: true })
		progressService.closeProgressModal()

		emitEndSync({ showNotice: true, failedCount: 2 })

		expect(progressService.syncFailedCount).toBe(2)
		expect(resultModal.open).not.toHaveBeenCalled()
		expect(notice).toHaveBeenCalledOnce()
	})
})

import { Notice, Setting, type TextComponent } from 'obsidian'
import { isNotNil } from 'ramda'
import CacheClearModal from '~/components/CacheClearModal'
import { IN_DEV } from '~/consts'
import i18n from '~/i18n'
import { blobStore } from '~/storage/blob'
import logger from '~/utils/logger'
import {
	getDefaultLogDirectory,
	normalizeLogDirectoryForVault,
	saveLogNote,
} from '~/utils/log-note'
import logsStringify from '~/utils/logs-stringify'
import BaseSettings from './settings.base'

export default class TroubleshootingSettings extends BaseSettings {
	private readonly blobGarbageCount = 5000
	private readonly blobGarbageSizeBytes = 64 * 1024
	private logDirectoryText: TextComponent | undefined
	private logDirectoryDraftDirty = false
	private logDirectoryCommitQueue: Promise<void> = Promise.resolve()
	private logDirectoryCommitVersion = 0
	private pendingLogDirectoryCommits = 0
	private lastPersistedLogDirectory: string | undefined
	private latestRequestedLogDirectory: string | undefined

	async display() {
		const previousText = this.logDirectoryText
		if (previousText && this.logDirectoryDraftDirty) {
			void this.flushLogDirectoryDraft(previousText)
		}
		this.logDirectoryText = undefined
		this.logDirectoryDraftDirty = false
		if (this.pendingLogDirectoryCommits === 0) {
			this.lastPersistedLogDirectory = this.plugin.settings.logDirectory
			this.latestRequestedLogDirectory = this.plugin.settings.logDirectory
		}
		this.containerEl.empty()
		const defaultLogDirectory = getDefaultLogDirectory(this.app.vault.configDir)
		new Setting(this.containerEl)
			.setName(i18n.t('settings.troubleshooting.title'))
			.setHeading()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.clearName'))
			.setDesc(i18n.t('settings.cache.clearDesc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.clear'))
					.onClick(async () => {
						new CacheClearModal(this.plugin, async (options) => {
							try {
								const cleared =
									await CacheClearModal.clearSelectedCaches(options)
								if (cleared.length > 0) {
									new Notice(i18n.t('settings.cache.cleared'))
								} else {
									new Notice(
										i18n.t('settings.cache.clearModal.nothingSelected'),
									)
								}
							} catch (error) {
								logger.error('Error clearing cache:', error)
								const message =
									error instanceof Error ? error.message : String(error)
								new Notice(`Error clearing cache: ${message}`)
							}
						}).open()
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.name'))
			.setDesc(i18n.t('settings.log.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.log.saveToNote'))
					.onClick(async () => {
						await this.saveLogsToNote()
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.directoryName'))
			.setDesc(
				i18n.t('settings.log.directoryDesc', {
					defaultPath: defaultLogDirectory,
				}),
			)
			.addText((text) => {
				this.logDirectoryText = text
				text
					.setPlaceholder(defaultLogDirectory)
					.setValue(
						this.latestRequestedLogDirectory ??
							this.plugin.settings.logDirectory,
					)
					.onChange(() => {
						if (this.logDirectoryText === text) {
							this.logDirectoryDraftDirty = true
						}
					})
				text.inputEl.addEventListener('blur', () => {
					if (this.logDirectoryText === text) {
						void this.flushLogDirectoryDraft(text)
					}
				})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.log.clearName'))
			.setDesc(i18n.t('settings.log.clearDesc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.log.clear')).onClick(() => {
					this.plugin.loggerService.clear()
					new Notice(i18n.t('settings.log.cleared'))
				})
			})

		if (IN_DEV) {
			new Setting(this.containerEl)
				.setName(i18n.t('settings.cache.generateBlobGarbageName'))
				.setDesc(
					i18n.t('settings.cache.generateBlobGarbageDesc', {
						count: this.blobGarbageCount,
						sizeKiB: this.blobGarbageSizeBytes / 1024,
					}),
				)
				.addButton((button) => {
					button
						.setButtonText(i18n.t('settings.cache.generateBlobGarbage'))
						.onClick(async () => {
							button.setDisabled(true)
							try {
								new Notice(i18n.t('settings.cache.generateBlobGarbageRunning'))
								const created = await this.generateBlobGarbage()
								new Notice(
									i18n.t('settings.cache.generateBlobGarbageDone', {
										count: created,
									}),
								)
							} catch (error) {
								logger.error('Error generating blob garbage:', error)
								new Notice(`Error: ${(error as Error).message}`)
							} finally {
								button.setDisabled(false)
							}
						})
				})
		}
	}

	async hide() {
		const text = this.logDirectoryText
		if (text && this.logDirectoryDraftDirty) {
			void this.flushLogDirectoryDraft(text)
		}
		await this.waitForLogDirectoryCommits()
		if (this.logDirectoryText === text) {
			this.logDirectoryText = undefined
			this.logDirectoryDraftDirty = false
		}
	}

	private flushLogDirectoryDraft(text: TextComponent) {
		if (this.logDirectoryText !== text || !this.logDirectoryDraftDirty) {
			return this.logDirectoryCommitQueue
		}
		if (this.pendingLogDirectoryCommits === 0) {
			const latestPersistedDirectory = this.plugin.settings.logDirectory
			this.lastPersistedLogDirectory = latestPersistedDirectory
			this.latestRequestedLogDirectory = latestPersistedDirectory
		}
		return this.commitLogDirectory(text)
	}

	private commitLogDirectory(text: TextComponent) {
		this.lastPersistedLogDirectory ??= this.plugin.settings.logDirectory
		this.latestRequestedLogDirectory ??= this.plugin.settings.logDirectory
		const directory = normalizeLogDirectoryForVault(
			text.getValue(),
			this.app.vault,
		)
		text.setValue(directory)
		if (this.logDirectoryText === text) {
			this.logDirectoryDraftDirty = false
		}
		if (directory === this.latestRequestedLogDirectory) {
			return this.logDirectoryCommitQueue
		}

		const commitVersion = ++this.logDirectoryCommitVersion
		this.latestRequestedLogDirectory = directory
		this.pendingLogDirectoryCommits++
		const commit = this.logDirectoryCommitQueue.then(async () => {
			try {
				await this.plugin.settingsService.persistSettings({
					logDirectory: directory,
				})
				this.lastPersistedLogDirectory = directory
				this.plugin.settings.logDirectory = directory
			} catch (error) {
				logger.error('Failed to save log directory setting:', error)
				if (commitVersion === this.logDirectoryCommitVersion) {
					const rollbackDirectory =
						this.lastPersistedLogDirectory ?? this.plugin.settings.logDirectory
					this.plugin.settings.logDirectory = rollbackDirectory
					this.latestRequestedLogDirectory = rollbackDirectory
					const activeText = this.logDirectoryText
					if (
						activeText &&
						!this.logDirectoryDraftDirty &&
						activeText.getValue() === directory
					) {
						activeText.setValue(rollbackDirectory)
					}
					new Notice(i18n.t('settings.log.directorySaveError'))
				}
			} finally {
				this.pendingLogDirectoryCommits--
			}
		})
		this.logDirectoryCommitQueue = commit
		return commit
	}

	private async waitForLogDirectoryCommits() {
		let observedQueue: Promise<void>
		do {
			observedQueue = this.logDirectoryCommitQueue
			await observedQueue
		} while (observedQueue !== this.logDirectoryCommitQueue)
	}

	private get logs() {
		return this.plugin.loggerService.logs
			.map(logsStringify)
			.filter(isNotNil)
			.join('\n\n')
	}

	private async saveLogsToNote() {
		try {
			const text = this.logDirectoryText
			if (text && this.logDirectoryDraftDirty) {
				void this.flushLogDirectoryDraft(text)
			}
			await this.waitForLogDirectoryCommits()
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
			const fileName = `nutstore-logs-${timestamp}.md`
			const content = `# Nutstore Plugin Logs\n\nGenerated at: ${new Date().toLocaleString()}\n\nPlugin version: ${this.plugin.manifest.version}\n\n---\n\n${this.logs}`

			const { file, filePath } = await saveLogNote(
				this.app.vault,
				this.plugin.settings.logDirectory,
				fileName,
				content,
			)
			new Notice(i18n.t('settings.log.savedToNote', { fileName: filePath }))
			await this.app.workspace.getLeaf().openFile(file)
		} catch (error) {
			new Notice(i18n.t('settings.log.saveError'))
			logger.error('Failed to save logs to note:', error)
		}
	}

	private async generateBlobGarbage() {
		function createRandomBytes(size: number) {
			const bytes = new Uint8Array(size)
			if (globalThis.crypto?.getRandomValues) {
				globalThis.crypto.getRandomValues(bytes)
				return bytes
			}
			for (let i = 0; i < bytes.length; i++) {
				bytes[i] = Math.floor(Math.random() * 256)
			}
			return bytes
		}

		let created = 0
		for (let i = 0; i < this.blobGarbageCount; i++) {
			const payload = createRandomBytes(this.blobGarbageSizeBytes)
			await blobStore.store(payload.buffer)
			created++
		}
		return created
	}
}

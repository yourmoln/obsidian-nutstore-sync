import { Notice, Setting, type TextComponent } from 'obsidian'
import { isNotNil } from 'ramda'
import CacheClearModal from '~/components/CacheClearModal'
import { IN_DEV } from '~/consts'
import i18n from '~/i18n'
import { blobStore } from '~/storage/blob'
import logger from '~/utils/logger'
import {
	DEFAULT_LOG_DIRECTORY,
	normalizeLogDirectory,
	saveLogNote,
} from '~/utils/log-note'
import logsStringify from '~/utils/logs-stringify'
import BaseSettings from './settings.base'

export default class TroubleshootingSettings extends BaseSettings {
	private readonly blobGarbageCount = 5000
	private readonly blobGarbageSizeBytes = 64 * 1024

	async display() {
		this.containerEl.empty()
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
					defaultPath: DEFAULT_LOG_DIRECTORY,
				}),
			)
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_LOG_DIRECTORY)
					.setValue(this.plugin.settings.logDirectory)
				text.inputEl.addEventListener('blur', () =>
					this.commitLogDirectory(text),
				)
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

	hide() {}

	private async commitLogDirectory(text: TextComponent) {
		const directory = normalizeLogDirectory(text.getValue())
		text.setValue(directory)
		if (directory === this.plugin.settings.logDirectory) return

		this.plugin.settings.logDirectory = directory
		await this.plugin.settingsService.saveSettings()
	}

	private get logs() {
		return this.plugin.loggerService.logs
			.map(logsStringify)
			.filter(isNotNil)
			.join('\n\n')
	}

	private async saveLogsToNote() {
		try {
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

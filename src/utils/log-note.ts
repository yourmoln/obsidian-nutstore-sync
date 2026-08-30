import type { Vault } from 'obsidian'
import { mkdirsVault } from './mkdirs-vault'

export const DEFAULT_LOG_DIRECTORY = 'nutstore-sync/logs'

function isAbsolutePath(path: string) {
	return path.startsWith('/') || /^[A-Za-z]:/.test(path)
}

export function normalizeLogDirectory(value?: string | null): string {
	const path = value?.trim().replace(/\\/g, '/') ?? ''
	if (!path || isAbsolutePath(path)) {
		return DEFAULT_LOG_DIRECTORY
	}

	const segments: string[] = []
	for (const rawSegment of path.split('/')) {
		const segment = rawSegment.trim()
		if (!segment || segment === '.') {
			continue
		}
		if (segment === '..' || /[\0\r\n]/.test(segment)) {
			return DEFAULT_LOG_DIRECTORY
		}
		segments.push(segment)
	}

	return segments.length > 0 ? segments.join('/') : DEFAULT_LOG_DIRECTORY
}

export async function saveLogNote(
	vault: Vault,
	directory: string | null | undefined,
	fileName: string,
	content: string,
) {
	const dirPath = normalizeLogDirectory(directory)
	await mkdirsVault(vault, dirPath)
	const filePath = `${dirPath}/${fileName}`
	const file = await vault.create(filePath, content)
	return { file, filePath }
}

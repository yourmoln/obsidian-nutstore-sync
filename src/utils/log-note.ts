import type { Vault } from 'obsidian'
import { mkdirsVault } from './mkdirs-vault'

export const DEFAULT_LOG_DIRECTORY = 'nutstore-sync/logs'

const WINDOWS_FORBIDDEN_PATH_CHARACTERS = /[<>:"|?*]/
const WINDOWS_RESERVED_DEVICE_NAME =
	/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function isAbsolutePath(path: string) {
	return path.startsWith('/') || /^[A-Za-z]:/.test(path)
}

function hasControlCharacter(value: string) {
	for (const character of value) {
		const codePoint = character.codePointAt(0)
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			return true
		}
	}
	return false
}

export function normalizeLogDirectory(value?: string | null): string {
	const rawPath = value ?? ''
	if (
		WINDOWS_FORBIDDEN_PATH_CHARACTERS.test(rawPath) ||
		hasControlCharacter(rawPath)
	) {
		return DEFAULT_LOG_DIRECTORY
	}

	const path = rawPath.trim().replace(/\\/g, '/')
	if (!path || isAbsolutePath(path)) {
		return DEFAULT_LOG_DIRECTORY
	}

	const segments: string[] = []
	for (const rawSegment of path.split('/')) {
		const segment = rawSegment.trim()
		if (!segment || segment === '.') {
			continue
		}
		if (
			segment === '..' ||
			segment.startsWith('.') ||
			rawSegment.endsWith(' ') ||
			segment.endsWith('.') ||
			WINDOWS_RESERVED_DEVICE_NAME.test(segment)
		) {
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

import type { Vault } from 'obsidian'
import { mkdirsVault } from './mkdirs-vault'

export const DEFAULT_LOG_DIRECTORY = 'nutstore-sync/logs'
export const MAX_LOG_DIRECTORY_SEGMENT_BYTES = 255
export const MAX_LOG_FILE_PATH_BYTES = 1024
export const LOG_FILE_NAME_BYTE_BUDGET = 64
export const MAX_LOG_DIRECTORY_PATH_BYTES =
	MAX_LOG_FILE_PATH_BYTES - LOG_FILE_NAME_BYTE_BUDGET - 1

const CONFIG_CONFLICT_LOG_DIRECTORY = 'nutstore-sync-logs'
const LOG_FILE_NAME_BUDGET_PLACEHOLDER = 'f'.repeat(LOG_FILE_NAME_BYTE_BUDGET)
const UTF8_ENCODER = new TextEncoder()

const WINDOWS_FORBIDDEN_PATH_CHARACTERS = /[<>:"|?*]/
const WINDOWS_RESERVED_DEVICE_NAME =
	/^(?:con|prn|aux|nul|(?:com|lpt)[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i

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

function utf8ByteLength(value: string) {
	return UTF8_ENCODER.encode(value).byteLength
}

function normalizeComparablePath(value: string) {
	return value
		.trim()
		.replace(/\\/g, '/')
		.split('/')
		.map((segment) => segment.trim().normalize('NFC'))
		.filter((segment) => segment && segment !== '.')
		.join('/')
		.toLowerCase()
}

function isInsideConfigDirectory(path: string, configDir?: string | null) {
	if (typeof configDir !== 'string') return false

	const normalizedConfigDir = normalizeComparablePath(configDir)
	if (!normalizedConfigDir) return false

	const normalizedPath = normalizeComparablePath(path)
	return (
		normalizedPath === normalizedConfigDir ||
		normalizedPath.startsWith(`${normalizedConfigDir}/`)
	)
}

export function getDefaultLogDirectory(configDir?: string | null) {
	return isInsideConfigDirectory(DEFAULT_LOG_DIRECTORY, configDir)
		? CONFIG_CONFLICT_LOG_DIRECTORY
		: DEFAULT_LOG_DIRECTORY
}

export function normalizeLogDirectory(
	value: unknown,
	configDir?: string | null,
): string {
	const fallbackDirectory = getDefaultLogDirectory(configDir)
	if (typeof value !== 'string') {
		return fallbackDirectory
	}

	const rawPath = value
	if (
		WINDOWS_FORBIDDEN_PATH_CHARACTERS.test(rawPath) ||
		hasControlCharacter(rawPath)
	) {
		return fallbackDirectory
	}

	const path = rawPath.trim().replace(/\\/g, '/')
	if (!path || isAbsolutePath(path)) {
		return fallbackDirectory
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
			WINDOWS_RESERVED_DEVICE_NAME.test(segment) ||
			utf8ByteLength(segment) > MAX_LOG_DIRECTORY_SEGMENT_BYTES
		) {
			return fallbackDirectory
		}
		segments.push(segment)
	}

	const normalizedPath = segments.join('/')
	if (
		!normalizedPath ||
		utf8ByteLength(normalizedPath) > MAX_LOG_DIRECTORY_PATH_BYTES ||
		isInsideConfigDirectory(normalizedPath, configDir)
	) {
		return fallbackDirectory
	}

	return normalizedPath
}

function isLogFilePathWithinBudget(vault: Vault, filePath: string) {
	if (utf8ByteLength(filePath) > MAX_LOG_FILE_PATH_BYTES) {
		return false
	}

	const adapter = vault.adapter as Vault['adapter'] & {
		getFullPath?: (path: string) => string
	}
	if (typeof adapter.getFullPath !== 'function') {
		return true
	}
	try {
		const fullPath = adapter.getFullPath(filePath)
		return utf8ByteLength(fullPath) <= MAX_LOG_FILE_PATH_BYTES
	} catch {
		// Keep the verifiable relative-path budget when an adapter cannot resolve.
		return true
	}
}

export function normalizeLogDirectoryForVault(value: unknown, vault: Vault) {
	const directory = normalizeLogDirectory(value, vault.configDir)
	const budgetedFilePath = `${directory}/${LOG_FILE_NAME_BUDGET_PLACEHOLDER}`
	if (isLogFilePathWithinBudget(vault, budgetedFilePath)) {
		return directory
	}
	return getDefaultLogDirectory(vault.configDir)
}

export async function saveLogNote(
	vault: Vault,
	directory: string | null | undefined,
	fileName: string,
	content: string,
) {
	const dirPath = normalizeLogDirectoryForVault(directory, vault)
	const filePath = `${dirPath}/${fileName}`
	if (!isLogFilePathWithinBudget(vault, filePath)) {
		throw new Error(
			`Log file path exceeds the ${MAX_LOG_FILE_PATH_BYTES}-byte safety budget`,
		)
	}
	await mkdirsVault(vault, dirPath)
	const file = await vault.create(filePath, content)
	return { file, filePath }
}

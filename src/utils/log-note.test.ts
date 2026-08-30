import type { Vault } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_LOG_DIRECTORY,
	MAX_LOG_DIRECTORY_PATH_BYTES,
	normalizeLogDirectory,
	saveLogNote,
} from './log-note'

const EXPECTED_MAX_LOG_FILE_PATH_BYTES = 1024
const EXPECTED_LOG_FILE_NAME_BYTE_BUDGET = 64
const EXPECTED_MAX_LOG_DIRECTORY_PATH_BYTES =
	EXPECTED_MAX_LOG_FILE_PATH_BYTES - EXPECTED_LOG_FILE_NAME_BYTE_BUDGET - 1

function createMockVault(
	configDir = '.obsidian',
	getFullPath?: (path: string) => string,
) {
	const folders = new Set<string>()
	const createFolder = vi.fn(async (path: string) => {
		folders.add(path)
	})
	const mkdir = vi.fn(async (path: string) => {
		folders.add(path)
	})
	const create = vi.fn(async (path: string) => ({ path }))
	const vault = {
		configDir,
		adapter: {
			exists: vi.fn(async (path: string) => folders.has(path)),
			mkdir,
			...(getFullPath ? { getFullPath } : {}),
		},
		createFolder,
		create,
	} as unknown as Vault

	return { vault, create, createFolder, mkdir }
}

function createAsciiPath(byteLength: number) {
	const segments: string[] = []
	let remaining = byteLength
	while (remaining > 255) {
		segments.push('a'.repeat(255))
		remaining -= 256
	}
	segments.push('a'.repeat(remaining))
	return segments.join('/')
}

describe('normalizeLogDirectory', () => {
	it.each([undefined, null, '', '   ', '/', '\\\\', './'])(
		'uses the default for an empty directory: %s',
		(value) => {
			expect(normalizeLogDirectory(value)).toBe(DEFAULT_LOG_DIRECTORY)
		},
	)

	it.each([
		['number', 42],
		['array', []],
		['object', {}],
	] as const)('uses the default for a non-string %s', (_type, value) => {
		expect(normalizeLogDirectory(value)).toBe(DEFAULT_LOG_DIRECTORY)
	})

	it('normalizes separators, whitespace, and dot segments', () => {
		expect(normalizeLogDirectory(' notes\\support//./logs/ ')).toBe(
			'notes/support/logs',
		)
		expect(normalizeLogDirectory(' support/logs ')).toBe('support/logs')
	})

	it.each([
		'/tmp/logs',
		'C:\\temp\\logs',
		'\\\\server\\share\\logs',
		'../outside',
		'notes/../../outside',
		'notes/../logs',
	])('falls back instead of accepting an unsafe path: %s', (value) => {
		expect(normalizeLogDirectory(value)).toBe(DEFAULT_LOG_DIRECTORY)
	})

	it.each([
		['forbidden character', 'support/logs?'],
		['control character', 'support/\u0001logs'],
		['trailing dot', 'support/logs.'],
		['trailing space', 'support/logs /archive'],
		['reserved device name', 'support/CON'],
		['reserved device name with extension', 'support/lpt9.logs'],
		['superscript reserved device name', 'support/COM\u00b9'],
		[
			'superscript reserved device name with extension',
			'support/LPT\u00b2.logs',
		],
	] as const)('rejects a Windows-invalid %s: %s', (_reason, value) => {
		expect(normalizeLogDirectory(value)).toBe(DEFAULT_LOG_DIRECTORY)
	})

	it.each(['.logs', '.obsidian/logs', 'support/.logs'])(
		'rejects a hidden or config directory segment: %s',
		(value) => {
			expect(normalizeLogDirectory(value)).toBe(DEFAULT_LOG_DIRECTORY)
		},
	)

	it.each(['config', 'config/logs', 'CONFIG/logs'])(
		'rejects the configured Obsidian directory: %s',
		(value) => {
			expect(normalizeLogDirectory(value, 'config')).toBe(DEFAULT_LOG_DIRECTORY)
		},
	)

	it('does not reject a same-named directory below another Vault folder', () => {
		expect(normalizeLogDirectory('notes/config/logs', 'config')).toBe(
			'notes/config/logs',
		)
	})

	it('treats NFC and NFD config directory spellings as equivalent', () => {
		const nfcConfigDir = '\u00e9-config'
		const nfdConfigDir = 'e\u0301-config'

		expect(normalizeLogDirectory(`${nfdConfigDir}/logs`, nfcConfigDir)).toBe(
			DEFAULT_LOG_DIRECTORY,
		)
	})

	it('preserves the user path Unicode representation outside comparisons', () => {
		const nfdDirectory = 'notes/e\u0301-logs'

		expect(normalizeLogDirectory(nfdDirectory, 'config')).toBe(nfdDirectory)
	})

	it('case-folds Greek sigma variants when excluding configDir', () => {
		const configDir = '\u03a3-config'
		const finalSigmaDirectory = '\u03c2-config/logs'

		expect(normalizeLogDirectory(finalSigmaDirectory, configDir)).toBe(
			DEFAULT_LOG_DIRECTORY,
		)
		expect(normalizeLogDirectory('notes/\u03c2-logs', configDir)).toBe(
			'notes/\u03c2-logs',
		)
	})

	it('accepts path segments at the 255-byte UTF-8 boundary', () => {
		const asciiPath = 'a'.repeat(255)
		const multibytePath = '界'.repeat(85)

		expect(new TextEncoder().encode(multibytePath).byteLength).toBe(255)
		expect(normalizeLogDirectory(asciiPath)).toBe(asciiPath)
		expect(normalizeLogDirectory(multibytePath)).toBe(multibytePath)
	})

	it.each([
		['256 ASCII bytes', 'a'.repeat(256)],
		['258 multibyte UTF-8 bytes', '界'.repeat(86)],
	] as const)('rejects a path segment over the limit: %s', (_case, value) => {
		expect(normalizeLogDirectory(value)).toBe(DEFAULT_LOG_DIRECTORY)
	})

	it('reserves the file name budget in the directory boundary', () => {
		const atLimit = createAsciiPath(EXPECTED_MAX_LOG_DIRECTORY_PATH_BYTES)
		const overLimit = `${atLimit}a`
		const budgetedFilePath = `${atLimit}/${'f'.repeat(
			EXPECTED_LOG_FILE_NAME_BYTE_BUDGET,
		)}`

		expect(MAX_LOG_DIRECTORY_PATH_BYTES).toBe(
			EXPECTED_MAX_LOG_DIRECTORY_PATH_BYTES,
		)
		expect(new TextEncoder().encode(budgetedFilePath).byteLength).toBe(
			EXPECTED_MAX_LOG_FILE_PATH_BYTES,
		)
		expect(normalizeLogDirectory(atLimit)).toBe(atLimit)
		expect(normalizeLogDirectory(overLimit)).toBe(DEFAULT_LOG_DIRECTORY)
	})
})

describe('saveLogNote', () => {
	it('creates default directory levels and the final file path', async () => {
		const { vault, create, createFolder } = createMockVault()

		const result = await saveLogNote(vault, undefined, 'log.md', 'content')

		expect(createFolder.mock.calls.map(([path]) => path)).toEqual([
			'nutstore-sync',
			DEFAULT_LOG_DIRECTORY,
		])
		expect(create).toHaveBeenCalledWith(
			`${DEFAULT_LOG_DIRECTORY}/log.md`,
			'content',
		)
		expect(result.filePath).toBe(`${DEFAULT_LOG_DIRECTORY}/log.md`)
	})

	it('normalizes and recursively creates a custom nested directory', async () => {
		const { vault, create, createFolder } = createMockVault()

		const result = await saveLogNote(
			vault,
			' support\\nested//logs/ ',
			'log.md',
			'content',
		)

		expect(createFolder.mock.calls.map(([path]) => path)).toEqual([
			'support',
			'support/nested',
			'support/nested/logs',
		])
		expect(create).toHaveBeenCalledWith('support/nested/logs/log.md', 'content')
		expect(result.filePath).toBe('support/nested/logs/log.md')
	})

	it('creates the file under the default after an unsafe custom path', async () => {
		const { vault, create } = createMockVault()

		await saveLogNote(vault, '../outside', 'log.md', 'content')

		expect(create).toHaveBeenCalledWith(
			`${DEFAULT_LOG_DIRECTORY}/log.md`,
			'content',
		)
	})

	it.each(['support/CON', '.obsidian/logs'])(
		'keeps an invalid directory out of adapter-only paths: %s',
		async (directory) => {
			const { vault, create, mkdir } = createMockVault()

			await saveLogNote(vault, directory, 'log.md', 'content')

			expect(mkdir).not.toHaveBeenCalled()
			expect(create).toHaveBeenCalledWith(
				`${DEFAULT_LOG_DIRECTORY}/log.md`,
				'content',
			)
		},
	)

	it('keeps a non-hidden custom config directory out of Vault paths', async () => {
		const { vault, create, mkdir } = createMockVault('config')

		await saveLogNote(vault, 'config/logs', 'log.md', 'content')

		expect(mkdir).not.toHaveBeenCalled()
		expect(create).toHaveBeenCalledWith(
			`${DEFAULT_LOG_DIRECTORY}/log.md`,
			'content',
		)
	})

	it('uses a safe fallback when the default is inside configDir', async () => {
		const { vault, create, mkdir } = createMockVault('nutstore-sync')

		await saveLogNote(vault, DEFAULT_LOG_DIRECTORY, 'log.md', 'content')

		expect(mkdir).not.toHaveBeenCalled()
		expect(create).toHaveBeenCalledWith('nutstore-sync-logs/log.md', 'content')
	})

	it('rejects a final relative file path over the byte budget', async () => {
		const { vault, create, createFolder } = createMockVault()
		const directory = createAsciiPath(EXPECTED_MAX_LOG_DIRECTORY_PATH_BYTES)
		const oversizedFileName = 'f'.repeat(EXPECTED_LOG_FILE_NAME_BYTE_BUDGET + 1)

		await expect(
			saveLogNote(vault, directory, oversizedFileName, 'content'),
		).rejects.toThrow(/path/i)
		expect(createFolder).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})

	it('falls back when the adapter full path exceeds the byte budget', async () => {
		const rootPrefix = `${'r'.repeat(200)}/`
		const { vault, create } = createMockVault(
			'.obsidian',
			(path) => `${rootPrefix}${path}`,
		)
		const directory = createAsciiPath(
			EXPECTED_MAX_LOG_DIRECTORY_PATH_BYTES - 100,
		)

		await saveLogNote(vault, directory, 'log.md', 'content')

		expect(create).toHaveBeenCalledWith(
			`${DEFAULT_LOG_DIRECTORY}/log.md`,
			'content',
		)
	})

	it('fails before creating folders when even the fallback full path is too long', async () => {
		const rootPrefix = `${'r'.repeat(EXPECTED_MAX_LOG_FILE_PATH_BYTES)}/`
		const { vault, create, createFolder } = createMockVault(
			'.obsidian',
			(path) => `${rootPrefix}${path}`,
		)

		await expect(
			saveLogNote(vault, 'custom/logs', 'log.md', 'content'),
		).rejects.toThrow(/path/i)
		expect(createFolder).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})
})

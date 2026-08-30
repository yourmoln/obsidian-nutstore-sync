import type { Vault } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_LOG_DIRECTORY,
	normalizeLogDirectory,
	saveLogNote,
} from './log-note'

function createMockVault() {
	const folders = new Set<string>()
	const createFolder = vi.fn(async (path: string) => {
		folders.add(path)
	})
	const create = vi.fn(async (path: string) => ({ path }))
	const vault = {
		configDir: '.obsidian',
		adapter: {
			exists: vi.fn(async (path: string) => folders.has(path)),
		},
		createFolder,
		create,
	} as unknown as Vault

	return { vault, create, createFolder }
}

describe('normalizeLogDirectory', () => {
	it.each([undefined, null, '', '   ', '/', '\\\\', './'])(
		'uses the default for an empty directory: %s',
		(value) => {
			expect(normalizeLogDirectory(value)).toBe(DEFAULT_LOG_DIRECTORY)
		},
	)

	it('normalizes separators, whitespace, and dot segments', () => {
		expect(normalizeLogDirectory(' notes\\support//./logs/ ')).toBe(
			'notes/support/logs',
		)
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
})

import { describe, expect, it } from 'vitest'
import { TFile, TFolder, type App, type Vault } from 'obsidian'
import { InMemoryFs, MountableFs, type IFileSystem } from 'just-bash/browser'
import { createBuiltinSkillsFs } from '~/ai/skills/builtin'
import type { PermissionRequest } from '~/ai/tools/permission-guard'
import { createVaultBash, execVaultBash, VAULT_MOUNT_POINT } from './runtime'
import {
	AGENTS_MOUNT_POINT,
	NUTSTORE_SYNC_AGENTS_MOUNT_POINT,
} from './mount-points'
import {
	applyNormalizedSettingsPatch,
	type NormalizedSettingsPatch,
} from '../settings-whitelist'
import type { NutstoreSettings } from '~/settings'
import { createVaultFileSystem } from '../vault-filesystem'
import { listVaultPaths, ObsidianVaultFs, ReversibleOpRecorder } from './fs'
import { ObsidianAdapterFs } from './adapter-fs'
import { ReversibleFs } from './reversible-fs'
import { restoreVirtualReversibleOperations } from '~/ai/chat/messages/message-ops'
import { decodeReversibleFileSnapshot } from '~/ai/chat/messages/reversible-content'

interface MockEntryFile {
	type: 'file'
	content: Uint8Array
	mtime: number
}

interface MockEntryFolder {
	type: 'folder'
	mtime: number
}

type MockEntry = MockEntryFile | MockEntryFolder

interface MockAbstractFile {
	path: string
	name: string
	parent: MockFolder | null
}

interface MockFile extends MockAbstractFile {
	stat: {
		size: number
		mtime: number
	}
}

interface MockFolder extends MockAbstractFile {
	children: Array<MockFile | MockFolder>
}

class MemoryVaultStore {
	private readonly entries = new Map<string, MockEntry>([
		['', { type: 'folder', mtime: 0 }],
	])

	constructor(
		initialFiles: Record<string, string> = {},
		initialFolders: string[] = [],
	) {
		for (const folder of initialFolders) {
			this.ensureFolder(folder)
		}
		for (const [path, content] of Object.entries(initialFiles)) {
			this.writeBinary(path, new TextEncoder().encode(content).buffer)
		}
	}

	normalize(path: string) {
		return path.replace(/^\/+|\/+$/g, '')
	}

	dirname(path: string) {
		if (!path || !path.includes('/')) {
			return ''
		}
		return path.slice(0, path.lastIndexOf('/'))
	}

	basename(path: string) {
		if (!path) {
			return ''
		}
		const normalized = this.normalize(path)
		return normalized.slice(normalized.lastIndexOf('/') + 1)
	}

	ensureFolder(path: string) {
		const normalized = this.normalize(path)
		if (!normalized) {
			return
		}
		const parent = this.dirname(normalized)
		if (parent !== normalized) {
			this.ensureFolder(parent)
		}
		if (!this.entries.has(normalized)) {
			this.entries.set(normalized, { type: 'folder', mtime: Date.now() })
		}
	}

	exists(path: string) {
		return this.entries.has(this.normalize(path))
	}

	stat(path: string) {
		const entry = this.entries.get(this.normalize(path))
		if (!entry) {
			return null
		}
		return {
			type: entry.type,
			ctime: entry.mtime,
			mtime: entry.mtime,
			size: entry.type === 'file' ? entry.content.byteLength : 0,
		}
	}

	readBinary(path: string) {
		const entry = this.entries.get(this.normalize(path))
		if (!entry || entry.type !== 'file') {
			throw new Error(`missing file: ${path}`)
		}
		return entry.content.buffer.slice(
			entry.content.byteOffset,
			entry.content.byteOffset + entry.content.byteLength,
		) as ArrayBuffer
	}

	writeBinary(path: string, data: ArrayBuffer) {
		const normalized = this.normalize(path)
		this.ensureFolder(this.dirname(normalized))
		this.entries.set(normalized, {
			type: 'file',
			content: new Uint8Array(data),
			mtime: Date.now(),
		})
	}

	remove(path: string) {
		this.entries.delete(this.normalize(path))
	}

	removeRecursive(path: string) {
		const normalized = this.normalize(path)
		for (const key of [...this.entries.keys()]) {
			if (key === normalized || key.startsWith(`${normalized}/`)) {
				this.entries.delete(key)
			}
		}
	}

	rename(fromPath: string, toPath: string) {
		const from = this.normalize(fromPath)
		const to = this.normalize(toPath)
		this.ensureFolder(this.dirname(to))
		const moved = [...this.entries.entries()]
			.filter(([key]) => key === from || key.startsWith(`${from}/`))
			.sort((left, right) => left[0].length - right[0].length)
		for (const [key, value] of moved) {
			this.entries.delete(key)
			const suffix = key.slice(from.length)
			this.entries.set(
				`${to}${suffix}`,
				value.type === 'folder'
					? { ...value }
					: { ...value, content: value.content.slice() },
			)
		}
	}

	listChildren(path: string) {
		const normalized = this.normalize(path)
		const prefix = normalized ? `${normalized}/` : ''
		return [...this.entries.keys()]
			.filter((key) => key.startsWith(prefix) && key !== normalized)
			.filter((key) => !key.slice(prefix.length).includes('/'))
			.sort()
	}
}

function createMockVault(
	initialFiles: Record<string, string> = {},
	initialFolders: string[] = [],
) {
	const store = new MemoryVaultStore(initialFiles, initialFolders)

	const buildFolder = (path: string, parent: MockFolder | null): MockFolder => {
		const normalized = store.normalize(path)
		const folder: MockFolder = Object.assign(new TFolder(), {
			path: normalized,
			name: normalized ? store.basename(normalized) : '',
			parent,
			children: [],
		})
		folder.children = store.listChildren(normalized).map((childPath) => {
			const childStat = store.stat(childPath)
			if (childStat?.type === 'folder') {
				return buildFolder(childPath, folder)
			}
			return Object.assign(new TFile(), {
				path: childPath,
				name: store.basename(childPath),
				parent: folder,
				stat: {
					size: childStat?.size ?? 0,
					mtime: childStat?.mtime ?? 0,
				},
			}) satisfies MockFile
		})
		return folder
	}

	const isHiddenPath = (path: string) =>
		store
			.normalize(path)
			.split('/')
			.some((segment) => segment.startsWith('.'))
	const root = () => {
		const folder = buildFolder('', null)
		folder.children = folder.children.filter(
			(child) => !isHiddenPath(child.path),
		)
		return folder
	}

	const vault = {
		getRoot() {
			return root()
		},
		getAbstractFileByPath(path: string) {
			const normalized = store.normalize(path)
			if (isHiddenPath(normalized)) {
				return null
			}
			if (!normalized) {
				return root()
			}
			const stat = store.stat(normalized)
			if (!stat) {
				return null
			}
			const parentPath = store.dirname(normalized)
			const parent =
				parentPath === normalized ? null : buildFolder(parentPath, null)
			if (stat.type === 'folder') {
				return buildFolder(normalized, parent)
			}
			return Object.assign(new TFile(), {
				path: normalized,
				name: store.basename(normalized),
				parent,
				stat: {
					size: stat.size,
					mtime: stat.mtime,
				},
			}) satisfies MockFile
		},
		async readBinary(file: MockFile) {
			return store.readBinary(file.path)
		},
		async createBinary(path: string, data: ArrayBuffer) {
			store.writeBinary(path, data)
			return vault.getAbstractFileByPath(path)
		},
		async cachedRead(file: MockFile) {
			return new TextDecoder().decode(store.readBinary(file.path))
		},
		async modifyBinary(file: MockFile, data: ArrayBuffer) {
			store.writeBinary(file.path, data)
		},
		async modify(file: MockFile, content: string) {
			store.writeBinary(file.path, new TextEncoder().encode(content).buffer)
		},
		async createFolder(path: string) {
			store.ensureFolder(path)
			return vault.getAbstractFileByPath(path)
		},
		async delete(file: MockFile | MockFolder) {
			const stat = store.stat(file.path)
			if (stat?.type === 'folder') {
				store.removeRecursive(file.path)
				return
			}
			store.remove(file.path)
		},
		async trash(file: MockFile | MockFolder) {
			return vault.delete(file as never)
		},
		async rename(file: MockFile | MockFolder, newPath: string) {
			store.rename(file.path, newPath)
		},
		adapter: {
			async exists(path: string) {
				return store.exists(path)
			},
			async stat(path: string) {
				const s = store.stat(path)
				if (!s) return null
				return {
					type: s.type === 'folder' ? ('folder' as const) : ('file' as const),
					mtime: s.mtime,
					size: s.size,
				}
			},
			async readBinary(path: string) {
				return store.readBinary(path)
			},
			async read(path: string) {
				return new TextDecoder().decode(store.readBinary(path))
			},
			async list(path: string) {
				const children = store.listChildren(path)
				return {
					files: children.filter((child) => store.stat(child)?.type === 'file'),
					folders: children.filter(
						(child) => store.stat(child)?.type === 'folder',
					),
				}
			},
			async writeBinary(path: string, data: ArrayBuffer) {
				store.writeBinary(path, data)
			},
			async write(path: string, data: string) {
				store.writeBinary(path, new TextEncoder().encode(data).buffer)
			},
			async appendBinary(path: string, data: ArrayBuffer) {
				const existing = store.exists(path)
					? new Uint8Array(store.readBinary(path))
					: new Uint8Array()
				const appended = new Uint8Array(existing.length + data.byteLength)
				appended.set(existing)
				appended.set(new Uint8Array(data), existing.length)
				store.writeBinary(path, appended.buffer)
			},
			async mkdir(path: string) {
				store.ensureFolder(path)
			},
			async create(path: string, data: string) {
				store.writeBinary(path, new TextEncoder().encode(data).buffer)
			},
			async createBinary(path: string, data: ArrayBuffer) {
				store.writeBinary(path, data)
			},
			async remove(path: string) {
				store.remove(path)
			},
			async rmdir(path: string, _recursive: boolean) {
				store.removeRecursive(path)
			},
			async rename(fromPath: string, toPath: string) {
				store.rename(fromPath, toPath)
			},
			async copy(fromPath: string, toPath: string) {
				store.writeBinary(toPath, store.readBinary(fromPath))
			},
		},
		configDir: '.obsidian',
	} as unknown as Vault

	return {
		vault,
		store,
	}
}

function createApp(vault: Vault) {
	return {
		vault,
	} as unknown as App
}

const filesystemCases: Array<[string, () => Promise<IFileSystem>]> = [
	[
		'Vault',
		async () => {
			const { vault } = createMockVault()
			return new ObsidianVaultFs(vault, ['/'])
		},
	],
	[
		'DataAdapter',
		async () => {
			const { vault } = createMockVault({}, ['.agents'])
			return ObsidianAdapterFs.create(vault.adapter, '.agents')
		},
	],
]

describe.each(filesystemCases)('%s filesystem contract', (_name, createFs) => {
	it('supports the shared mutable file lifecycle', async () => {
		const fs = await createFs()
		await fs.writeFile('/notes/a.md', 'a')
		await fs.appendFile('/notes/a.md', 'b')
		await fs.cp('/notes/a.md', '/notes/b.md')
		await fs.mv('/notes/b.md', '/notes/c.md')

		expect(await fs.readFile('/notes/a.md')).toBe('ab')
		expect(await fs.readdir('/notes')).toEqual(['a.md', 'c.md'])
		await fs.rm('/notes/c.md')
		expect(await fs.exists('/notes/c.md')).toBe(false)
	})
})

describe('vault bash runtime', () => {
	it('uses the adapter mtime for vault directories', async () => {
		const { vault } = createMockVault({}, ['docs'])
		const bash = await createVaultBash(createApp(vault))

		const stat = await bash.fs.stat('/vault/docs')

		expect(stat.mtime.getTime()).toBeGreaterThan(0)
	})

	it('reads and writes hidden Vault Skills through the adapter mount', async () => {
		const { vault, store } = createMockVault({
			'.agents/skills/custom/SKILL.md': '# Custom',
		})
		const app = createApp(vault)

		expect(vault.getAbstractFileByPath('.agents/skills/custom/SKILL.md')).toBe(
			null,
		)
		const reads: string[] = []
		const requests: PermissionRequest[] = []
		const result = await execVaultBash(
			app,
			`cat ${AGENTS_MOUNT_POINT}/skills/custom/SKILL.md && printf "new" > ${AGENTS_MOUNT_POINT}/skills/new/SKILL.md`,
			{
				onRead: (path) => reads.push(path),
				permissionGuard: async (request) => {
					requests.push(request)
				},
			},
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('# Custom')
		expect(
			new TextDecoder().decode(store.readBinary('.agents/skills/new/SKILL.md')),
		).toBe('new')
		expect(reads).toEqual(['.agents/skills/custom/SKILL.md'])
		expect(requests).toEqual([
			{
				type: 'fs',
				fs: {
					kind: 'write',
					path: `${AGENTS_MOUNT_POINT}/skills/new/SKILL.md`,
				},
			},
		])
		expect(result.reversibleOps).toEqual([
			{
				vaultPath: '/.agents/skills/new',
				operation: 'create',
				before: { kind: 'dir' },
				after: { kind: 'dir' },
			},
			{
				vaultPath: '/.agents/skills/new/SKILL.md',
				operation: 'create',
				before: { kind: 'file' },
				after: expect.objectContaining({
					kind: 'file',
					contentCompressed: {
						compress: 'deflate',
						blob: expect.any(Blob),
					},
				}),
			},
		])
	})

	it('exposes the built-in skill-creator below the plugin namespace', async () => {
		const { vault } = createMockVault()
		const result = await execVaultBash(
			createApp(vault),
			`cat ${NUTSTORE_SYNC_AGENTS_MOUNT_POINT}/builtin-skills/skill-creator/SKILL.md`,
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('name: skill-creator')
		expect(result.stdout).toContain('# Skill Creator')
	})

	it('rejects every mutation route into the built-in Skills mount', async () => {
		const mounted = new MountableFs({
			base: new InMemoryFs(),
			mounts: [
				{
					mountPoint: '/.agents/nutstore-sync/builtin-skills',
					filesystem: await createBuiltinSkillsFs(),
				},
			],
		})
		await mounted.writeFile('/source', 'source')
		const file = '/.agents/nutstore-sync/builtin-skills/skill-creator/SKILL.md'
		const mutations: Array<[() => Promise<unknown>, string]> = [
			[() => mounted.writeFile(file, 'changed'), 'read-only'],
			[() => mounted.appendFile(file, 'changed'), 'read-only'],
			[
				() => mounted.mkdir('/.agents/nutstore-sync/builtin-skills/new-skill'),
				'read-only',
			],
			[() => mounted.rm(file), 'read-only'],
			[() => mounted.cp('/source', file), 'read-only'],
			[() => mounted.mv(file, '/moved'), 'read-only'],
			[() => mounted.mv('/source', file), 'read-only'],
			[() => mounted.chmod(file, 0o777), 'read-only'],
			[() => mounted.symlink('/target', file), 'read-only'],
			[() => mounted.link(file, '/linked'), 'cross-device'],
			[() => mounted.utimes(file, new Date(), new Date()), 'read-only'],
		]

		for (const [mutate, error] of mutations) {
			await expect(mutate()).rejects.toThrow(error)
		}
		expect(await mounted.readFile(file)).toContain('name: skill-creator')
	})

	it('builds a vault path snapshot for globbing', async () => {
		const { vault } = createMockVault(
			{
				'notes/today.md': 'hello',
			},
			['notes'],
		)
		const app = createApp(vault)

		await expect(listVaultPaths(app)).resolves.toEqual(
			expect.arrayContaining(['/', '/notes', '/notes/today.md']),
		)
	})

	it('mounts the Obsidian vault under /vault and supports writes', async () => {
		const { vault, store } = createMockVault(
			{
				'docs/readme.md': 'hello world\n',
			},
			['docs'],
		)
		const app = createApp(vault)

		const result = await execVaultBash(
			app,
			'cat /vault/docs/readme.md && printf "done" > /vault/docs/output.txt',
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('hello world')
		expect(new TextDecoder().decode(store.readBinary('docs/output.txt'))).toBe(
			'done',
		)
	})

	it('mounts /tmp to the persistent plugin temporary directory', async () => {
		const { vault, store } = createMockVault({
			'.agents/nutstore-sync/tmp/session/tasks/task.txt': 'result',
		})
		const requests: PermissionRequest[] = []

		const result = await execVaultBash(
			createApp(vault),
			'cat /tmp/session/tasks/task.txt && printf "next" > /tmp/session/tasks/next.txt',
			{
				permissionGuard: async (request) => {
					requests.push(request)
				},
			},
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('result')
		expect(
			new TextDecoder().decode(
				store.readBinary('.agents/nutstore-sync/tmp/session/tasks/next.txt'),
			),
		).toBe('next')
		expect(requests).toEqual([
			{
				type: 'fs',
				fs: {
					kind: 'write',
					path: '/tmp/session/tasks/next.txt',
				},
			},
		])
	})

	it('does not expose or reuse the legacy plugin cache as /tmp', async () => {
		const legacyPath =
			'.obsidian/plugins/nutstore-sync/cache/fs/tmp/session/tasks/legacy-旧缓存.txt'
		const { vault, store } = createMockVault({
			[legacyPath]: 'legacy / 旧缓存',
		})
		const fs = await createVaultFileSystem(createApp(vault))

		expect(await fs.readdir('/')).toEqual([
			AGENTS_MOUNT_POINT.split('/').filter(Boolean)[0],
			'tmp',
			'vault',
		])
		expect(await fs.exists('/tmp/session/tasks/legacy-旧缓存.txt')).toBe(false)

		await fs.writeFile('/tmp/session/tasks/current-当前.txt', 'current / 当前')

		expect(
			new TextDecoder().decode(
				store.readBinary(
					'.agents/nutstore-sync/tmp/session/tasks/current-当前.txt',
				),
			),
		).toBe('current / 当前')
		expect(
			store.exists(
				'.obsidian/plugins/nutstore-sync/cache/fs/tmp/session/tasks/current-当前.txt',
			),
		).toBe(false)
		expect(new TextDecoder().decode(store.readBinary(legacyPath))).toBe(
			'legacy / 旧缓存',
		)
	})

	it('supports shell glob expansion from the initial vault snapshot', async () => {
		const { vault } = createMockVault(
			{
				'notes/a.md': 'A',
				'notes/b.md': 'B',
			},
			['notes'],
		)
		const bash = await createVaultBash(createApp(vault))

		const result = await bash.exec('printf "%s\n" /vault/notes/*.md')
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('/vault/notes/a.md')
		expect(result.stdout).toContain('/vault/notes/b.md')
	})

	it('exposes /vault as a mount while preserving scratch space outside it', async () => {
		const { vault } = createMockVault(
			{
				'note.md': 'hello',
			},
			[],
		)
		const mounted = new MountableFs({
			mounts: [
				{
					mountPoint: '/vault',
					filesystem: new ObsidianVaultFs(vault, ['/', '/note.md']),
				},
			],
		})

		await mounted.writeFile('/scratch.txt', 'temp')
		expect(await mounted.readFile('/scratch.txt')).toBe('temp')
		expect(await mounted.readFile(`${VAULT_MOUNT_POINT}/note.md`)).toBe('hello')
		expect(await mounted.readdir('/')).toEqual(['scratch.txt', 'vault'])
	})

	it('records reversible ops for writes, deletes, copies, and moves', async () => {
		const { vault } = createMockVault(
			{
				'docs/existing.md': 'before',
				'docs/nested/a.txt': 'A',
			},
			['docs', 'docs/nested'],
		)
		const recorder = new ReversibleOpRecorder()
		const fs = new ReversibleFs(
			new ObsidianVaultFs(
				vault,
				[
					'/',
					'/docs',
					'/docs/existing.md',
					'/docs/nested',
					'/docs/nested/a.txt',
				],
				undefined,
			),
			recorder,
		)

		await fs.writeFile('/docs/new.md', 'new')
		await fs.writeFile('/docs/existing.md', 'after')
		await fs.mkdir('/docs/deep/child', { recursive: true })
		await fs.rm('/docs/nested', { recursive: true })
		await fs.cp('/docs', '/docs-copy', { recursive: true })
		await fs.mv('/docs/new.md', '/moved/new.md')

		const operations = await recorder.getNetOperations()
		expect(
			operations.map(({ vaultPath, operation }) => [vaultPath, operation]),
		).toEqual([
			['/docs-copy', 'create'],
			['/moved', 'create'],
			['/docs-copy/deep', 'create'],
			['/docs-copy/existing.md', 'create'],
			['/docs-copy/new.md', 'create'],
			['/docs/deep', 'create'],
			['/docs/existing.md', 'update'],
			['/docs/nested', 'delete'],
			['/moved/new.md', 'create'],
			['/docs-copy/deep/child', 'create'],
			['/docs/deep/child', 'create'],
			['/docs/nested/a.txt', 'delete'],
		])
		expect(
			operations.every((operation) => operation.vaultPath.startsWith('/')),
		).toBe(true)
	})

	it('checks cp destination and mv source plus destination in permission guard', async () => {
		const { vault } = createMockVault(
			{
				'docs/source.md': 'source',
			},
			['docs'],
		)
		const requests: PermissionRequest[] = []
		const fs = new ObsidianVaultFs(
			vault,
			['/', '/docs', '/docs/source.md'],
			async (request) => {
				requests.push(request)
			},
		)

		await fs.cp('/docs/source.md', '/docs/copied.md')
		await fs.mv('/docs/copied.md', '/docs/moved.md')

		expect(requests).toEqual([
			{
				type: 'fs',
				fs: {
					kind: 'copy',
					src: '/vault/docs/source.md',
					dest: '/vault/docs/copied.md',
				},
			},
			{
				type: 'fs',
				fs: {
					kind: 'move',
					src: '/vault/docs/copied.md',
					dest: '/vault/docs/moved.md',
				},
			},
		])
	})

	it('records overwritten target content for cp and mv', async () => {
		const { vault } = createMockVault(
			{
				'docs/src-copy.md': 'copy-source',
				'docs/src-move.md': 'move-source',
				'docs/dest-copy.md': 'copy-dest-before',
				'docs/dest-move.md': 'move-dest-before',
			},
			['docs'],
		)
		const recorder = new ReversibleOpRecorder()
		const fs = new ReversibleFs(
			new ObsidianVaultFs(
				vault,
				[
					'/',
					'/docs',
					'/docs/src-copy.md',
					'/docs/src-move.md',
					'/docs/dest-copy.md',
					'/docs/dest-move.md',
				],
				undefined,
			),
			recorder,
		)

		await fs.cp('/docs/src-copy.md', '/docs/dest-copy.md')
		await fs.mv('/docs/src-move.md', '/docs/dest-move.md')

		expect(
			(await recorder.getNetOperations()).map(({ vaultPath, operation }) => [
				vaultPath,
				operation,
			]),
		).toEqual([
			['/docs/dest-copy.md', 'update'],
			['/docs/dest-move.md', 'update'],
			['/docs/src-move.md', 'delete'],
		])
	})

	it('records delete + create when a directory is replaced by a file at the same path', async () => {
		const { vault } = createMockVault(
			{
				'docs/case/note.md': 'keep',
			},
			['docs', 'docs/case'],
		)
		const recorder = new ReversibleOpRecorder()
		const fs = new ReversibleFs(
			new ObsidianVaultFs(
				vault,
				['/', '/docs', '/docs/case', '/docs/case/note.md'],
				undefined,
			),
			recorder,
		)

		await fs.rm('/docs/case', { recursive: true })
		await fs.writeFile('/docs/case', 'now a file')

		const operations = await recorder.getNetOperations()
		expect(
			operations.map(({ vaultPath, operation }) => [vaultPath, operation]),
		).toEqual([
			['/docs/case', 'delete'],
			['/docs/case', 'create'],
			['/docs/case/note.md', 'delete'],
		])

		const deleteOp = operations[0]
		const createOp = operations[1]
		expect(deleteOp).toMatchObject({
			operation: 'delete',
			before: { kind: 'dir' },
		})
		expect(createOp).toMatchObject({
			operation: 'create',
			after: { kind: 'file' },
		})
	})

	it('records delete + create when a file is replaced by a directory at the same path', async () => {
		const { vault } = createMockVault(
			{
				'docs/case.md': 'content',
			},
			['docs'],
		)
		const recorder = new ReversibleOpRecorder()
		const fs = new ReversibleFs(
			new ObsidianVaultFs(vault, ['/', '/docs', '/docs/case.md'], undefined),
			recorder,
		)

		await fs.rm('/docs/case.md')
		await fs.mkdir('/docs/case.md', { recursive: true })

		const operations = await recorder.getNetOperations()
		expect(
			operations.map(({ vaultPath, operation }) => [vaultPath, operation]),
		).toEqual([
			['/docs/case.md', 'delete'],
			['/docs/case.md', 'create'],
		])
		const deleteOp = operations[0]
		const createOp = operations[1]
		expect(deleteOp).toMatchObject({
			operation: 'delete',
			before: { kind: 'file' },
		})
		expect(createOp).toMatchObject({
			operation: 'create',
			after: { kind: 'dir' },
		})
	})

	it('keeps an unchanged directory out of net operations', async () => {
		const { vault } = createMockVault(
			{
				'docs/touch.md': 'x',
			},
			['docs', 'docs/touch-dir'],
		)
		const recorder = new ReversibleOpRecorder()
		const fs = new ReversibleFs(
			new ObsidianVaultFs(
				vault,
				['/', '/docs', '/docs/touch.md', '/docs/touch-dir'],
				undefined,
			),
			recorder,
		)

		await fs.mkdir('/docs/touch-dir', { recursive: true })

		const operations = await recorder.getNetOperations()
		expect(
			operations.map(({ vaultPath, operation }) => [vaultPath, operation]),
		).toEqual([])
	})

	describe('onRead callback', () => {
		it('fires onRead with vault-relative path when readFile succeeds', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				(path) => reads.push(path),
			)

			const content = await fs.readFile('/notes/file.md')

			expect(content).toBe('hello')
			expect(reads).toEqual(['notes/file.md'])
		})

		it('fires onRead with vault-relative path when readFileBuffer succeeds', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				(path) => reads.push(path),
			)

			const buf = await fs.readFileBuffer('/notes/file.md')

			expect(new TextDecoder().decode(buf)).toBe('hello')
			expect(reads).toEqual(['notes/file.md'])
		})

		it('does not fire onRead for stat', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				(path) => reads.push(path),
			)

			await fs.stat('/notes/file.md')

			expect(reads).toEqual([])
		})

		it('does not fire onRead for readdir', async () => {
			const { vault } = createMockVault(
				{ 'notes/a.md': 'A', 'notes/b.md': 'B' },
				['notes'],
			)
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/a.md', '/notes/b.md'],
				undefined,
				(path) => reads.push(path),
			)

			await fs.readdir('/notes')

			expect(reads).toEqual([])
		})

		it('does not fire onRead when reading a non-existent file (ENOENT)', async () => {
			const { vault } = createMockVault({}, [])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(vault, ['/'], undefined, (path) =>
				reads.push(path),
			)

			await expect(fs.readFile('/missing.md')).rejects.toThrow()
			expect(reads).toEqual([])
		})

		it('does not fire onRead when reading a directory (EISDIR)', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				(path) => reads.push(path),
			)

			await expect(fs.readFile('/notes')).rejects.toThrow()
			expect(reads).toEqual([])
		})

		it('fires onRead exactly once for readFile (not double via readFileBuffer)', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				(path) => reads.push(path),
			)

			await fs.readFile('/notes/file.md')

			expect(reads).toEqual(['notes/file.md'])
		})

		it('threads onRead through execVaultBash when bash reads a vault file', async () => {
			const { vault } = createMockVault({ 'docs/readme.md': 'hello world\n' }, [
				'docs',
			])
			const app = createApp(vault)
			const reads: string[] = []

			const result = await execVaultBash(app, 'cat /vault/docs/readme.md', {
				onRead: (path) => reads.push(path),
			})

			expect(result.exitCode).toBe(0)
			expect(result.stdout).toContain('hello world')
			expect(reads).toEqual(['docs/readme.md'])
		})

		it('preserves UTF-8 bytes when cat redirects a vault file into another vault file', async () => {
			const { vault, store } = createMockVault(
				{ 'docs/source.md': '中文测试\n' },
				['docs'],
			)
			const app = createApp(vault)

			const result = await execVaultBash(
				app,
				'cat /vault/docs/source.md > /vault/docs/copy.md',
			)

			expect(result.exitCode).toBe(0)
			expect(new TextDecoder().decode(store.readBinary('docs/copy.md'))).toBe(
				'中文测试\n',
			)
		})

		it('does not fire onRead for bash ls on a vault directory', async () => {
			const { vault } = createMockVault(
				{ 'docs/a.md': 'A', 'docs/b.md': 'B' },
				['docs'],
			)
			const app = createApp(vault)
			const reads: string[] = []

			await execVaultBash(app, 'ls /vault/docs', {
				onRead: (path) => reads.push(path),
			})

			expect(reads).toEqual([])
		})

		it('does not fire onRead for appendFile (internal read is not an agent read)', async () => {
			const { vault } = createMockVault({ 'docs/file.md': 'hello' }, ['docs'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/docs', '/docs/file.md'],
				undefined,
				(path) => reads.push(path),
			)

			await fs.appendFile('/docs/file.md', ' world')

			expect(reads).toEqual([])
		})

		it('does not fire onRead for utimes (internal read is not an agent read)', async () => {
			const { vault } = createMockVault({ 'docs/file.md': 'hello' }, ['docs'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/docs', '/docs/file.md'],
				undefined,
				(path) => reads.push(path),
			)

			await fs.utimes('/docs/file.md', new Date(), new Date())

			expect(reads).toEqual([])
		})
	})

	describe('UTF-8 byte-stream regression', () => {
		it('preserves UTF-8 when cat writes a heredoc with Chinese text', async () => {
			const { vault, store } = createMockVault({}, ['docs'])
			const app = createApp(vault)

			const result = await execVaultBash(
				app,
				`cat > /vault/docs/heredoc.md << 'EOF'
你好世界
EOF`,
			)

			expect(result.exitCode).toBe(0)
			expect(
				new TextDecoder().decode(store.readBinary('docs/heredoc.md')),
			).toBe('你好世界\n')
		})

		it('preserves 4-byte UTF-8 (emoji) when cat writes a heredoc', async () => {
			const { vault, store } = createMockVault({}, ['docs'])
			const app = createApp(vault)

			const result = await execVaultBash(
				app,
				`cat > /vault/docs/emoji.md << 'EOF'
🚀中文
EOF`,
			)

			expect(result.exitCode).toBe(0)
			expect(new TextDecoder().decode(store.readBinary('docs/emoji.md'))).toBe(
				'🚀中文\n',
			)
		})

		it('preserves UTF-8 when echo pipes through tee into a vault file', async () => {
			const { vault, store } = createMockVault({}, ['docs'])
			const app = createApp(vault)

			const result = await execVaultBash(
				app,
				`echo '你好世界' | tee /vault/docs/tee.md > /dev/null`,
			)

			expect(result.exitCode).toBe(0)
			expect(new TextDecoder().decode(store.readBinary('docs/tee.md'))).toBe(
				'你好世界\n',
			)
		})

		it('preserves UTF-8 when echo writes directly to a vault file (text path)', async () => {
			const { vault, store } = createMockVault({}, ['docs'])
			const app = createApp(vault)

			const result = await execVaultBash(
				app,
				`echo '你好世界' > /vault/docs/echo.md`,
			)

			expect(result.exitCode).toBe(0)
			expect(new TextDecoder().decode(store.readBinary('docs/echo.md'))).toBe(
				'你好世界\n',
			)
		})
	})
})

describe('settings virtual file through bash', () => {
	function makeSettings(): NutstoreSettings {
		return {
			account: '',
			credential: '',
			nutstoreEnterpriseBaseUrl: '',
			remoteDir: '',
			conflictStrategy:
				'no-conflict-merge' as NutstoreSettings['conflictStrategy'],
			oauthResponseText: '',
			loginMode: 'sso',
			confirmBeforeSync: true,
			showSyncResultModal: true,
			confirmBeforeDeleteInAutoSync: true,
			syncMode: 'loose' as NutstoreSettings['syncMode'],
			filterRules: {
				rules: [
					{
						expr: '**/.DS_Store',
						options: { caseSensitive: false },
						type: 'exclude',
					},
				],
			},
			skipLargeFiles: { maxSize: '30 MB' },
			mobileAppDownloadFileChunkSize: '16 MiB',
			realtimeSync: false,
			startupSyncDelaySeconds: 0,
			autoSyncIntervalSeconds: 300,
			language: undefined,
			ai: { providers: {} },
			configDirSyncMode: 'none',
		}
	}

	it('reads the whitelist and applies a written file to settings', async () => {
		const { vault } = createMockVault()
		const app = createApp(vault)
		const settings = makeSettings()
		const updates: NormalizedSettingsPatch[] = []
		const filePath = '/.config/nutstore-sync/settings.json'
		const requests: PermissionRequest[] = []

		const read = await execVaultBash(app, `cat ${filePath}`, {
			getSettingsSnapshot: () => settings,
			updateSettings: async (patch) => {
				updates.push(patch)
				applyNormalizedSettingsPatch(settings, patch)
			},
			permissionGuard: async (request) => {
				requests.push(request)
			},
		})
		expect(read.exitCode).toBe(0)
		expect(read.stdout).toContain('"filterRules"')
		expect(read.stdout).not.toContain('credential')

		const write = await execVaultBash(
			app,
			`printf '{"realtimeSync":true}' > ${filePath}`,
			{
				getSettingsSnapshot: () => settings,
				updateSettings: async (patch) => {
					updates.push(patch)
					applyNormalizedSettingsPatch(settings, patch)
				},
				permissionGuard: async (request) => {
					requests.push(request)
				},
			},
		)
		expect(write.exitCode).toBe(0)
		expect(updates).toEqual([{ realtimeSync: true }])
		expect(settings.realtimeSync).toBe(true)
		expect(requests).toEqual([
			{
				type: 'settings',
				settings: {
					action: 'update',
					summary: expect.stringContaining('Realtime sync'),
					changes: { realtimeSync: true },
				},
			},
		])
	})

	it('records and restores a bilingual settings update through the recall path', async () => {
		const { vault } = createMockVault()
		const app = createApp(vault)
		const settings = makeSettings()
		const filePath = '/.config/nutstore-sync/settings.json'
		const settingsIo = {
			getSettingsSnapshot: () => settings,
			updateSettings: async (patch: NormalizedSettingsPatch) => {
				applyNormalizedSettingsPatch(settings, patch)
			},
		}

		const write = await execVaultBash(
			app,
			`printf '{"realtimeSync":true,"language":"zh"}' > ${filePath}`,
			settingsIo,
		)

		expect(settings.realtimeSync).toBe(true)
		expect(settings.language).toBe('zh')
		expect(write.reversibleOps).toHaveLength(1)
		const operation = write.reversibleOps[0]
		expect(operation).toMatchObject({
			vaultPath: filePath,
			operation: 'update',
			before: { kind: 'file' },
			after: { kind: 'file' },
		})
		if (operation.operation !== 'update' || !operation.after) {
			throw new Error('expected a settings update operation')
		}
		const before = new TextDecoder().decode(
			await decodeReversibleFileSnapshot(operation.before),
		)
		const after = new TextDecoder().decode(
			await decodeReversibleFileSnapshot(operation.after),
		)
		expect(before).toContain('"realtimeSync": false')
		expect(after).toContain('"realtimeSync": true')
		expect(after).toContain('"language": "zh"')

		await restoreVirtualReversibleOperations(app, write.reversibleOps, {
			settingsIo,
		})

		expect(settings.realtimeSync).toBe(false)
		expect(settings.language).toBeUndefined()
	})

	it('rejects an invalid settings write through bash', async () => {
		const { vault } = createMockVault()
		const app = createApp(vault)
		const settings = makeSettings()
		const filePath = '/.config/nutstore-sync/settings.json'

		await expect(
			execVaultBash(app, `printf '{oops' > ${filePath}`, {
				getSettingsSnapshot: () => settings,
				updateSettings: async () => {},
			}),
		).rejects.toThrow(/not valid JSON/)
	})
})

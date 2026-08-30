import { describe, expect, it } from 'vitest'
import { InMemoryFs, MountableFs } from 'just-bash/browser'
import { SETTINGS_MOUNT_POINT } from './bash/mount-points'
import { SettingsFs } from './settings-fs'
import {
	applyNormalizedSettingsPatch,
	describeSettingsPatch,
	parseSettingsWhitelistJson,
	serializeSettingsWhitelist,
} from './settings-whitelist'
import type { NutstoreSettings } from '~/settings'
import type { NormalizedSettingsPatch } from './settings-whitelist'
import type { PermissionRequest } from './permission-guard'

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
		ai: {
			providers: {},
		},
		configDirSyncMode: 'none',
	}
}

function makeFs(
	settings: NutstoreSettings,
	updates: NormalizedSettingsPatch[],
) {
	return new SettingsFs({
		getSettings: () => settings,
		updateSettings: async (patch) => {
			updates.push(patch)
		},
	})
}

describe('serializeSettingsWhitelist', () => {
	it('exposes the whitelist but never credentials', () => {
		const settings = makeSettings()
		settings.account = 'user@example.com'
		settings.credential = 'secret-app-password'
		settings.oauthResponseText = 'sensitive-ticket'
		const file = JSON.parse(serializeSettingsWhitelist(settings)) as Record<
			string,
			unknown
		>
		expect(file).not.toHaveProperty('account')
		expect(file).not.toHaveProperty('credential')
		expect(file).not.toHaveProperty('oauthResponseText')
		expect(file).not.toHaveProperty('ai')
		expect(file.filterRules).toEqual({
			rules: [
				{
					expr: '**/.DS_Store',
					type: 'exclude',
					caseSensitive: false,
				},
			],
		})
		expect(file.skipLargeFiles).toEqual({ maxSize: '30 MB' })
		expect(file.syncMode).toBe('loose')
		expect(file.showSyncResultModal).toBe(true)
	})

	it('round-trips through the parser without lossy changes', () => {
		const settings = makeSettings()
		const result = parseSettingsWhitelistJson(
			serializeSettingsWhitelist(settings),
		)
		expect(result).toMatchObject({ ok: true })
		if (!result.ok) return
		expect(result.patch.skipLargeFilesMaxSize).toBe('30 MB')
		expect(result.patch.filterRules?.[0]?.expr).toBe('**/.DS_Store')
		expect(result.patch.showSyncResultModal).toBe(true)
	})

	it('parses, applies, and describes the successful result toggle', () => {
		const result = parseSettingsWhitelistJson(
			JSON.stringify({ showSyncResultModal: false }),
		)
		expect(result).toEqual({
			ok: true,
			patch: { showSyncResultModal: false },
			text: JSON.stringify({ showSyncResultModal: false }),
		})
		if (!result.ok) return

		const settings = makeSettings()
		applyNormalizedSettingsPatch(settings, result.patch)

		expect(settings.showSyncResultModal).toBe(false)
		expect(describeSettingsPatch(result.patch)).toEqual([
			'Show successful sync result: off',
		])
	})

	it('rejects a non-boolean successful result toggle', () => {
		const result = parseSettingsWhitelistJson(
			JSON.stringify({ showSyncResultModal: 'no' }),
		)

		expect(result).toMatchObject({ ok: false })
		if (result.ok) return
		expect(result.error).toContain("'showSyncResultModal'")
		expect(result.error).toContain('boolean')
	})

	it('serializes and round-trips a disabled rule', () => {
		const settings = makeSettings()
		settings.filterRules.rules = [
			{
				expr: '**/.env',
				options: { caseSensitive: false },
				type: 'exclude',
				disabled: true,
			},
		]
		const file = JSON.parse(serializeSettingsWhitelist(settings)) as {
			filterRules: { rules: Array<Record<string, unknown>> }
		}
		expect(file.filterRules.rules[0]?.disabled).toBe(true)

		const result = parseSettingsWhitelistJson(
			serializeSettingsWhitelist(settings),
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.patch.filterRules?.[0]?.disabled).toBe(true)
	})

	it('omits disabled for an active rule in the serialized file', () => {
		const file = JSON.parse(serializeSettingsWhitelist(makeSettings())) as {
			filterRules: { rules: Array<Record<string, unknown>> }
		}
		expect(file.filterRules.rules[0]).not.toHaveProperty('disabled')
	})

	it('rejects a non-boolean disabled value', () => {
		const result = parseSettingsWhitelistJson(
			JSON.stringify({
				filterRules: {
					rules: [{ expr: '*.md', type: 'exclude', disabled: 'yes' }],
				},
			}),
		)
		expect(result.ok).toBe(false)
	})
})

describe('SettingsFs read surface', () => {
	it('serves the settings file as valid JSON', async () => {
		const fs = makeFs(makeSettings(), [])
		expect(await fs.exists('/settings.json')).toBe(true)
		expect(await fs.exists('/other')).toBe(false)
		expect(await fs.readdir('/')).toEqual(['settings.json'])
		const stat = await fs.stat('/settings.json')
		expect(stat.isFile).toBe(true)
		expect(stat.size).toBeGreaterThan(0)
		const text = await fs.readFile('/settings.json')
		expect(() => JSON.parse(text)).not.toThrow()
		expect(
			(JSON.parse(text) as { filterRules: { rules: unknown[] } }).filterRules
				.rules.length,
		).toBe(1)
	})
})

describe('SettingsFs write path', () => {
	it('applies a valid full-file write and forwards the normalized patch', async () => {
		const settings = makeSettings()
		const updates: NormalizedSettingsPatch[] = []
		const requests: PermissionRequest[] = []
		const fs = new SettingsFs({
			getSettings: () => settings,
			updateSettings: async (patch) => {
				updates.push(patch)
			},
			permissionGuard: async (request) => {
				requests.push(request)
			},
		})
		const next: NutstoreSettings = {
			...makeSettings(),
			startupSyncDelaySeconds: 12,
			syncMode: 'strict' as NutstoreSettings['syncMode'],
		}
		await fs.writeFile('/settings.json', serializeSettingsWhitelist(next))

		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({
			type: 'settings',
			settings: { action: 'update' },
		})
		const summary = (requests[0] as { settings: { summary: string } }).settings
			.summary
		expect(summary).toContain('Auto sync after startup')
		expect(updates).toHaveLength(1)
		expect(updates[0]).toMatchObject({
			startupSyncDelaySeconds: 12,
			syncMode: 'strict',
		})
		expect(updates[0].filterRules?.[0]?.expr).toBe('**/.DS_Store')
	})

	it('rejects invalid JSON', async () => {
		const updates: NormalizedSettingsPatch[] = []
		const fs = makeFs(makeSettings(), updates)
		await expect(fs.writeFile('/settings.json', '{oops')).rejects.toThrow(
			/not valid JSON/,
		)
		expect(updates).toHaveLength(0)
	})

	it('rejects unknown keys to protect credentials', async () => {
		const updates: NormalizedSettingsPatch[] = []
		const fs = makeFs(makeSettings(), updates)
		await expect(
			fs.writeFile('/settings.json', JSON.stringify({ credential: 'x' })),
		).rejects.toThrow(/unknown key 'credential'/)
		expect(updates).toHaveLength(0)
	})

	it('clamps out-of-range numbers', async () => {
		const settings = makeSettings()
		const updates: NormalizedSettingsPatch[] = []
		const fs = makeFs(settings, updates)
		await fs.writeFile(
			'/settings.json',
			JSON.stringify({ startupSyncDelaySeconds: 999999 }),
		)
		expect(updates).toEqual([{ startupSyncDelaySeconds: 86400 }])
	})

	it('rejects invalid enums and oversized byte sizes', async () => {
		const updates: NormalizedSettingsPatch[] = []
		const fs = makeFs(makeSettings(), updates)
		await expect(
			fs.writeFile('/settings.json', JSON.stringify({ syncMode: 'turbo' })),
		).rejects.toThrow(/'strict' or 'loose'/)
		await expect(
			fs.writeFile(
				'/settings.json',
				JSON.stringify({ skipLargeFiles: { maxSize: '10 GB' } }),
			),
		).rejects.toThrow(/exceeds the maximum/)
		expect(updates).toHaveLength(0)
	})

	it('rejects destructive and unsupported mutations', async () => {
		const fs = makeFs(makeSettings(), [])
		await expect(fs.appendFile('/settings.json', 'x')).rejects.toThrow(/EROFS/)
		await expect(fs.rm('/settings.json')).rejects.toThrow(/EROFS/)
		await expect(fs.cp('/settings.json', '/x')).rejects.toThrow(/EROFS/)
		await expect(fs.writeFile('/not-settings.json', '{}')).rejects.toThrow(
			/ENOENT/,
		)
	})
})

describe('SettingsFs mounted in a MountableFs', () => {
	it('is reachable at the settings mount point and reflects live settings', async () => {
		const settings = makeSettings()
		const updates: NormalizedSettingsPatch[] = []
		const settingsFs = new SettingsFs({
			getSettings: () => settings,
			updateSettings: async (patch) => {
				updates.push(patch)
				applyNormalizedSettingsPatch(settings, patch)
			},
		})
		const mounted = new MountableFs({
			base: new InMemoryFs(),
			mounts: [{ mountPoint: SETTINGS_MOUNT_POINT, filesystem: settingsFs }],
		})

		expect(await mounted.readdir('/.config')).toEqual(['nutstore-sync'])
		const filePath = `${SETTINGS_MOUNT_POINT}/settings.json`
		expect(await mounted.exists(filePath)).toBe(true)
		const text = await mounted.readFile(filePath)
		expect(text).toContain('"filterRules"')

		await mounted.writeFile(filePath, JSON.stringify({ realtimeSync: true }))
		expect(updates).toEqual([{ realtimeSync: true }])
		expect(await mounted.readFile(filePath)).toContain('"realtimeSync": true')
	})
})

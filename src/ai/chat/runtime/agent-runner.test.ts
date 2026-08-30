import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { AgentRunner } from '~/ai/chat/runtime/agent-runner'

const toolLoopOptions = vi.hoisted(() => vi.fn())

vi.mock('ai', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ai')>()
	return {
		...actual,
		isLoopFinished: vi.fn(() => vi.fn()),
		ToolLoopAgent: class {
			constructor(options: unknown) {
				toolLoopOptions(options)
			}

			async stream(options: { onStepEnd: (step: unknown) => Promise<void> }) {
				return {
					stream: (async function* () {
						await options.onStepEnd({
							response: {
								id: 'response',
								modelId: 'model',
								messages: [
									{
										role: 'assistant',
										content: [{ type: 'text', text: 'done' }],
									},
								],
							},
							usage: {},
							finishReason: 'stop',
							content: [],
						})
						yield { type: 'text-delta', text: '' }
					})(),
				}
			}
		},
	}
})

vi.mock('~/ai/chat/prompts', async (importOriginal) => ({
	...(await importOriginal<typeof import('~/ai/chat/prompts')>()),
	buildAgentSystemPrompt: vi.fn(async () => 'system'),
}))

vi.mock('~/ai/chat/runtime/agent-event-projector', () => ({
	AgentEventProjector: class {
		async project() {}
	},
}))

vi.mock('~/ai/core/runtime', () => ({
	prepareMessagesForModel: (
		_provider: unknown,
		_modelId: string,
		messages: unknown,
	) => messages,
	resolveLanguageModel: () => ({ model: {} }),
}))

async function runAgent(sessionMaxTokens?: number) {
	const session: ChatSession = {
		schemaVersion: 2,
		id: 'session',
		createdAt: 1,
		updatedAt: 1,
		...(sessionMaxTokens === undefined
			? {}
			: { inferenceParams: { maxTokens: sessionMaxTokens } }),
		subagents: { master: {} as never },
	}
	const toolExecutor = {
		getAgentDefinition: () => ({}),
		createTools: vi.fn(async () => ({})),
		createStableToolsContext: () => ({ app: {} }),
		prepareReadTracker: () => ({ resetSnapshot: vi.fn() }),
	}
	const runner = new AgentRunner(
		toolExecutor as never,
		{} as never,
		{} as never,
		vi.fn(),
		{} as never,
	)

	await runner.runTurn({
		session,
		agent: { id: 'master', type: 'master', timeline: [] } as never,
		provider: { id: 'provider', name: 'Provider' } as never,
		model: {
			id: 'model',
			name: 'Model',
			limit: { context: 1_000_000, output: 384_000 },
		} as never,
		depth: 0,
		assistantMeta: {},
		isCancelled: () => false,
		isDeleted: () => false,
		buildMessages: async () => [],
	})
}

describe('AgentRunner inference options', () => {
	beforeEach(() => {
		toolLoopOptions.mockReset()
	})

	it('uses the configured model output limit by default', async () => {
		await runAgent()

		expect(toolLoopOptions).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: 384_000 }),
		)
	})

	it('prefers an explicit session output limit', async () => {
		await runAgent(16_000)

		expect(toolLoopOptions).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: 16_000 }),
		)
	})
})

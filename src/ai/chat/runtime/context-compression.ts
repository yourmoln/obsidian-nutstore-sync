import { generateText, type ModelMessage, type ToolSet } from 'ai'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import { findLatestTodos, resolveUsedContextTokens } from '~/ai/chat/domain'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import {
	selectContextTimeline,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import { buildAgentSystemPrompt, COMPRESSION_PROMPT } from '~/ai/chat/prompts'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import { resolveMaxOutputTokens } from '~/ai/chat/runtime/inference-options'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import {
	prepareMessagesForModel,
	resolveLanguageModel,
} from '~/ai/core/runtime'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'

const FALLBACK_CONTEXT_WINDOW = 256 * 1024
const MIN_AUTO_COMPRESSION_THRESHOLD = 4096 * 4
const AUTO_COMPRESSION_CONTEXT_RATIO = 0.1
const RECENT_TURNS_CONTEXT_RATIO = 0.05
const MIN_RECENT_TURNS_TOKEN_BUDGET = 2048
const MAX_RECENT_TURNS_TOKEN_BUDGET = 4096 * 4
const MAX_RECENT_TURNS = 8
const ESTIMATED_UTF8_BYTES_PER_TOKEN = 3

export function resolveContextWindow(model?: AIModelConfig) {
	const configuredLimit = model?.limit?.context
	return configuredLimit && configuredLimit > 0
		? configuredLimit
		: FALLBACK_CONTEXT_WINDOW
}

function resolveAutoCompressionThreshold(contextWindow: number) {
	return Math.max(
		contextWindow * AUTO_COMPRESSION_CONTEXT_RATIO,
		MIN_AUTO_COMPRESSION_THRESHOLD,
	)
}

function resolveRecentTurnsTokenBudget(contextWindow: number) {
	return Math.min(
		MAX_RECENT_TURNS_TOKEN_BUDGET,
		Math.max(
			MIN_RECENT_TURNS_TOKEN_BUDGET,
			contextWindow * RECENT_TURNS_CONTEXT_RATIO,
		),
	)
}

function isContextCheckpoint(message: AppUIMessage) {
	return message.parts.some((part) => part.type === 'data-context-checkpoint')
}

function estimateSerializedTokens(value: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
	return Math.ceil(bytes / ESTIMATED_UTF8_BYTES_PER_TOKEN)
}

export async function findRecentTurnStartIndex(
	messages: AppUIMessage[],
	tokenBudget: number,
) {
	const turnStarts = messages.flatMap((message, index) =>
		message.role === 'user' && !isContextCheckpoint(message) ? [index] : [],
	)
	if (turnStarts.length === 0) {
		const firstConversationMessage = messages.findIndex(
			(message) => !isContextCheckpoint(message),
		)
		return firstConversationMessage < 0
			? messages.length
			: firstConversationMessage
	}

	let firstPreservedTurn = turnStarts.at(-1)!
	let preservedTokens = 0
	let preservedTurns = 0
	for (let turn = turnStarts.length - 1; turn >= 0; turn -= 1) {
		const start = turnStarts[turn]
		const end = turnStarts[turn + 1] ?? messages.length
		const modelMessages = await uiMessagesToModelMessages(
			messages.slice(start, end),
		)
		const turnTokens = estimateSerializedTokens(modelMessages)
		if (
			preservedTurns > 0 &&
			(preservedTurns >= MAX_RECENT_TURNS ||
				preservedTokens + turnTokens > tokenBudget)
		) {
			break
		}
		firstPreservedTurn = start
		preservedTokens += turnTokens
		preservedTurns += 1
	}
	return firstPreservedTurn
}

export function shouldAutoCompressAgent(
	agent: ChatAgentState,
	model?: AIModelConfig,
) {
	const contextTimeline = selectContextTimeline(agent.timeline)
	const checkpointCreatedAt = contextTimeline[0]?.parts.some(
		(part) => part.type === 'data-context-checkpoint',
	)
		? contextTimeline[0].metadata?.createdAt
		: undefined
	const latestUsage = [...contextTimeline]
		.reverse()
		.find(
			(message) =>
				message.role === 'assistant' &&
				message.metadata?.llm?.usage &&
				(checkpointCreatedAt === undefined ||
					(message.metadata.createdAt ?? 0) > checkpointCreatedAt),
		)?.metadata?.llm?.usage
	const usedTokens = resolveUsedContextTokens(latestUsage)
	if (usedTokens <= 0) return false
	const contextWindow = resolveContextWindow(model)
	return (
		contextWindow - usedTokens < resolveAutoCompressionThreshold(contextWindow)
	)
}

interface CompressContextRunnerOptions {
	provider: AIProviderConfig
	model: AIModelConfig
	session: ChatSession
	agent: ChatAgentState
	store: SessionStore
	messageFactory: MessageFactory
	/** System prompt identical to the main loop's, so the summarizer replays the warm prefix. */
	system?: string
	/** Per-agent tools identical to the main loop's, for the same prefix reason. */
	tools?: ToolSet
	/** Builds the message transcript exactly like the agent loop (user-context aware). */
	buildMessages?: (
		agent: ChatAgentState,
		tools: ToolSet,
	) => Promise<ModelMessage[]>
	isCancelled?: () => boolean
	abortSignal?: AbortSignal
}

/**
 * Resolve the system prompt + per-agent tools both callers (auto and manual)
 * reuse so the summarizer request is a byte-for-byte prefix of the last routed
 * turn. Degrades gracefully ({} on failure) so a tool-creation hiccup never
 * blocks compression.
 */
export async function resolveSummaryContext(
	agent: ChatAgentState,
	session: ChatSession,
	model: AIModelConfig,
	toolExecutor: ToolExecutor,
	app: App,
): Promise<{ system?: string; tools?: ToolSet }> {
	try {
		const definition = toolExecutor.getAgentDefinition(agent.type)
		const [system, tools] = await Promise.all([
			buildAgentSystemPrompt(app, agent.type, session.systemPrompt),
			toolExecutor.createTools(0, definition, session, model),
		])
		return { system, tools }
	} catch {
		return {}
	}
}

export async function runContextCompression({
	provider,
	model,
	session,
	agent,
	store,
	messageFactory,
	system,
	tools,
	buildMessages,
	isCancelled,
	abortSignal,
}: CompressContextRunnerOptions) {
	const contextTimeline = selectContextTimeline(agent.timeline)
	if (contextTimeline.length === 0) return
	const { model: languageModel } = resolveLanguageModel(provider, model.id)
	const messageSequence =
		buildMessages && tools
			? await buildMessages(agent, tools)
			: await uiMessagesToModelMessages(contextTimeline, tools)
	const preparedMessages = prepareMessagesForModel(
		provider,
		model.id,
		messageSequence,
	)
	// Append the compaction instruction as a separate final user message AFTER
	// preparation: adjacent-user merging must never fold it into the last turn,
	// so the summarizer request stays a genuine prefix of the last routed turn.
	const summarizerMessages: ModelMessage[] = [
		...preparedMessages,
		{
			role: 'user',
			content: [{ type: 'text', text: COMPRESSION_PROMPT }],
		},
	]
	const response = await generateText({
		model: languageModel,
		...(system === undefined ? {} : { system }),
		...(tools === undefined ? {} : { tools }),
		messages: summarizerMessages,
		abortSignal,
		temperature: session.inferenceParams?.temperature,
		maxOutputTokens: resolveMaxOutputTokens(
			session.inferenceParams?.maxTokens,
			model.limit?.output,
		),
	})
	if (isCancelled?.()) return
	const summary = response.text.trim() || COMPRESSION_PROMPT
	const todos = findLatestTodos(session)
	const todoLines = todos.map(
		(todo) => `- [${todo.status}] ${todo.content} (${todo.priority})`,
	)
	const finalSummary =
		todos.length > 0
			? [
					summary,
					'',
					'<CurrentTodoList>',
					...todoLines,
					'</CurrentTodoList>',
				].join('\n')
			: summary
	const preservedTurnIndex = await findRecentTurnStartIndex(
		contextTimeline,
		resolveRecentTurnsTokenBudget(resolveContextWindow(model)),
	)
	const preservedTurnCount = contextTimeline
		.slice(preservedTurnIndex)
		.filter(
			(message) => message.role === 'user' && !isContextCheckpoint(message),
		).length
	messageFactory.appendContextBoundary(session, agent, {
		mode: 'summary',
		summary: finalSummary,
		preservedTurnCount,
	})
	store.upsertSessionIndexItem(session, deriveTitle(session))
	await store.persistSession(session)
	await store.persistMetaAndIndex()
}

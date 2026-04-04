import { OPENROUTER_BASE_URL, CLAUDE_MAX_TOKENS, BRAINSTORM_SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT, VOICE_COMMAND_SYSTEM_PROMPT } from '../config'

interface OpenRouterResponse {
	choices: { message: { content: string } }[]
}

export interface VoiceCommandClassification {
	type: 'image' | 'video'
	prompt: string
	params: Record<string, unknown>
}

// Sends a canvas screenshot to Claude via OpenRouter and returns a single
// image generation prompt to pass to Higgsfield.
export async function generateBrainstormPrompt(
	apiKey: string,
	model: string,
	imageBase64: string,
	mimeType: string
): Promise<string> {
	const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model,
			max_tokens: CLAUDE_MAX_TOKENS,
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'image_url',
							image_url: { url: `data:${mimeType};base64,${imageBase64}` },
						},
						{
							type: 'text',
							text: BRAINSTORM_SYSTEM_PROMPT,
						},
					],
				},
			],
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`OpenRouter error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as OpenRouterResponse
	const content = data.choices?.[0]?.message?.content?.trim()

	if (!content) throw new Error('OpenRouter returned empty response')

	return content
}

// Sends a serialized canvas state (and optional user message) to Claude and
// returns its plain-text response.
export async function invokeAgent(
	apiKey: string,
	model: string,
	serializedCanvas: string,
	message?: string,
	image?: string,
	mimeType?: string,
): Promise<string> {
	const textContent = message
		? `${serializedCanvas}\n\nUser message: ${message}`
		: serializedCanvas

	const userContent: unknown[] = []

	if (image && mimeType) {
		userContent.push({
			type: 'image_url',
			image_url: { url: `data:${mimeType};base64,${image}` },
		})
	}

	userContent.push({ type: 'text', text: textContent })

	const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model,
			max_tokens: CLAUDE_MAX_TOKENS,
			messages: [
				{ role: 'system', content: AGENT_SYSTEM_PROMPT },
				{ role: 'user', content: userContent },
			],
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`OpenRouter error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as OpenRouterResponse
	const content = data.choices?.[0]?.message?.content?.trim()

	if (!content) throw new Error('OpenRouter returned empty response')

	return content
}

// Classifies a voice command as image or video generation and extracts the prompt + params.
export async function classifyVoiceCommand(
	apiKey: string,
	model: string,
	command: string
): Promise<VoiceCommandClassification> {
	const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model,
			max_tokens: CLAUDE_MAX_TOKENS,
			messages: [
				{ role: 'system', content: VOICE_COMMAND_SYSTEM_PROMPT },
				{ role: 'user', content: command },
			],
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`OpenRouter error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as OpenRouterResponse
	const raw = data.choices?.[0]?.message?.content?.trim()
	if (!raw) throw new Error('OpenRouter returned empty response')

	const jsonMatch = raw.match(/\{[\s\S]*\}/)
	if (!jsonMatch) throw new Error(`OpenRouter did not return JSON: ${raw}`)

	return JSON.parse(jsonMatch[0]) as VoiceCommandClassification
}

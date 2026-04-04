import { OPENROUTER_BASE_URL, CLAUDE_MAX_TOKENS, AGENT_SYSTEM_PROMPT } from '../config'

interface OpenRouterResponse {
	choices: { message: { content: string } }[]
}

// Sends canvas state (and optionally a screenshot) to Claude via OpenRouter.
// Returns Claude's raw text response (expected to contain JSON).
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

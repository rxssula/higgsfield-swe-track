import {
	HIGGSFIELD_BASE_URL,
	HIGGSFIELD_POLL_INTERVAL_MS,
	HIGGSFIELD_POLL_TIMEOUT_MS,
} from '../config'

interface SubmitResponse {
	request_id: string
	status: string
}

interface StatusResponse {
	status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw'
	request_id: string
	images?: { url: string }[]
	video?: { url: string }
}

function legacyAuthHeaders(apiKey: string, apiSecret: string): Record<string, string> {
	return {
		Authorization: `Key ${apiKey}:${apiSecret}`,
		'Content-Type': 'application/json',
	}
}

function hfHeaders(apiKey: string, apiSecret: string): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'hf-api-key': apiKey,
		'hf-secret': apiSecret,
	}
}

// Submit a generation request to Higgsfield (legacy auth). Returns the request_id.
export async function submitGeneration(
	apiKey: string,
	apiSecret: string,
	model: string,
	prompt: string
): Promise<string> {
	const response = await fetch(`${HIGGSFIELD_BASE_URL}/${model}`, {
		method: 'POST',
		headers: legacyAuthHeaders(apiKey, apiSecret),
		body: JSON.stringify({ prompt }),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Higgsfield submit error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as SubmitResponse
	if (!data.request_id) throw new Error('Higgsfield returned no request_id')

	return data.request_id
}

// Submit a text-to-image generation via the flux-2 endpoint.
export async function submitImageGeneration(
	apiKey: string,
	apiSecret: string,
	prompt: string,
	params: Record<string, unknown> = {}
): Promise<string> {
	const body = {
		prompt,
		image_urls: params.image_urls ?? [],
		resolution: params.resolution ?? '1k',
		aspect_ratio: params.aspect_ratio ?? '4:3',
		prompt_upsampling: params.prompt_upsampling ?? true,
	}

	const response = await fetch(`${HIGGSFIELD_BASE_URL}/flux-2`, {
		method: 'POST',
		headers: hfHeaders(apiKey, apiSecret),
		body: JSON.stringify(body),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Higgsfield image submit error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as SubmitResponse
	if (!data.request_id) throw new Error('Higgsfield returned no request_id')

	return data.request_id
}

// Submit a text-to-video generation via the Kling v3.0 endpoint.
export async function submitVideoGeneration(
	apiKey: string,
	apiSecret: string,
	prompt: string,
	params: Record<string, unknown> = {}
): Promise<string> {
	const body = {
		prompt,
		params: {
			sound: params.sound ?? 'on',
			duration: params.duration ?? 5,
			elements: params.elements ?? [],
			cfg_scale: params.cfg_scale ?? 0.5,
			multi_shots: params.multi_shots ?? false,
			aspect_ratio: params.aspect_ratio ?? '16:9',
			multi_prompt: params.multi_prompt ?? [],
		},
	}

	const response = await fetch(
		`${HIGGSFIELD_BASE_URL}/generate/kling-video/v3.0/std/text-to-video`,
		{
			method: 'POST',
			headers: hfHeaders(apiKey, apiSecret),
			body: JSON.stringify(body),
		}
	)

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Higgsfield video submit error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as SubmitResponse
	if (!data.request_id) throw new Error('Higgsfield returned no request_id')

	return data.request_id
}

// Polls the status endpoint until completed, failed, or timeout.
// Used by the legacy agent pipeline (returns just the URL string).
export async function pollUntilDone(
	apiKey: string,
	apiSecret: string,
	requestId: string
): Promise<string> {
	const result = await pollStatus(apiKey, apiSecret, requestId)
	return result.url
}

// Polls the status endpoint until completed, failed, or timeout.
// Returns both URL and media type for the voice command pipeline.
export async function pollUntilDoneWithType(
	apiKey: string,
	apiSecret: string,
	requestId: string
): Promise<{ url: string; mediaType: 'image' | 'video' }> {
	return pollStatus(apiKey, apiSecret, requestId)
}

async function pollStatus(
	apiKey: string,
	apiSecret: string,
	requestId: string
): Promise<{ url: string; mediaType: 'image' | 'video' }> {
	const deadline = Date.now() + HIGGSFIELD_POLL_TIMEOUT_MS

	while (Date.now() < deadline) {
		await sleep(HIGGSFIELD_POLL_INTERVAL_MS)

		const response = await fetch(`${HIGGSFIELD_BASE_URL}/requests/${requestId}/status`, {
			headers: hfHeaders(apiKey, apiSecret),
		})

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Higgsfield poll error ${response.status}: ${text}`)
		}

		const data = (await response.json()) as StatusResponse

		if (data.status === 'completed') {
			if (data.video?.url) return { url: data.video.url, mediaType: 'video' }
			if (data.images?.[0]?.url) return { url: data.images[0].url, mediaType: 'image' }
			throw new Error('Higgsfield completed but returned no media URL')
		}

		if (data.status === 'failed') throw new Error('Higgsfield generation failed')
		if (data.status === 'nsfw') throw new Error('Higgsfield rejected prompt (NSFW)')
	}

	throw new Error('Higgsfield generation timed out after 60s')
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

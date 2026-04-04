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

function authHeader(apiKey: string, apiSecret: string) {
	return `Key ${apiKey}:${apiSecret}`
}

// Submit a generation request to Higgsfield. Returns the request_id.
export async function submitGeneration(
	apiKey: string,
	apiSecret: string,
	model: string,
	prompt: string
): Promise<string> {
	const response = await fetch(`${HIGGSFIELD_BASE_URL}/${model}`, {
		method: 'POST',
		headers: {
			Authorization: authHeader(apiKey, apiSecret),
			'Content-Type': 'application/json',
		},
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

// Polls the status endpoint every 2s until completed, failed, or timeout.
export async function pollUntilDone(
	apiKey: string,
	apiSecret: string,
	requestId: string
): Promise<string> {
	const deadline = Date.now() + HIGGSFIELD_POLL_TIMEOUT_MS

	while (Date.now() < deadline) {
		await sleep(HIGGSFIELD_POLL_INTERVAL_MS)

		const response = await fetch(`${HIGGSFIELD_BASE_URL}/requests/${requestId}/status`, {
			headers: { Authorization: authHeader(apiKey, apiSecret) },
		})

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Higgsfield poll error ${response.status}: ${text}`)
		}

		const data = (await response.json()) as StatusResponse

		if (data.status === 'completed') {
			const url = data.images?.[0]?.url ?? data.video?.url
			if (!url) throw new Error('Higgsfield completed but returned no media URL')
			return url
		}

		if (data.status === 'failed') throw new Error('Higgsfield generation failed')
		if (data.status === 'nsfw') throw new Error('Higgsfield rejected prompt (NSFW)')

		// queued or in_progress — keep polling
	}

	throw new Error('Higgsfield generation timed out after 60s')
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

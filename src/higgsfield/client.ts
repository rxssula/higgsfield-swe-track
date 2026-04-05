import { HIGGSFIELD_BASE_URL } from "../config";

interface SubmitResponse {
    request_id: string;
    status: string;
}

interface KlingVideoJob {
    id: string;
    job_set_type: string;
    status: string;
    results: unknown;
}

interface KlingVideoSubmitResponse {
    id: string;
    type: string;
    created_at: string;
    jobs: KlingVideoJob[];
    input_params: Record<string, unknown>;
}

export interface GenerationStatusResponse {
    status: string;
    id?: string;
    request_id?: string;
    images?: { url: string }[];
    image?: { url: string };
    video?: { url: string };
    videos?: { url: string }[];
    error?: string;
}

function legacyAuthHeaders(
    apiKey: string,
    apiSecret: string,
): Record<string, string> {
    return {
        Authorization: `Key ${apiKey}:${apiSecret}`,
        "Content-Type": "application/json",
    };
}

function hfHeaders(apiKey: string, apiSecret: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "hf-api-key": apiKey,
        "hf-secret": apiSecret,
    };
}

// Submit a generation request to Higgsfield (legacy auth). Returns the request_id.
export async function submitGeneration(
    apiKey: string,
    apiSecret: string,
    model: string,
    prompt: string,
): Promise<string> {
    const response = await fetch(`${HIGGSFIELD_BASE_URL}/${model}`, {
        method: "POST",
        headers: legacyAuthHeaders(apiKey, apiSecret),
        body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Higgsfield submit error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as SubmitResponse;
    if (!data.request_id) throw new Error("Higgsfield returned no request_id");

    return data.request_id;
}

export async function getGenerationStatus(
    apiKey: string,
    apiSecret: string,
    requestId: string,
): Promise<GenerationStatusResponse> {
    const url = `${HIGGSFIELD_BASE_URL}/requests/${requestId}/status`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Key ${apiKey}:${apiSecret}`,
            "hf-api-key": apiKey,
            "hf-secret": apiSecret,
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Higgsfield status error ${response.status}: ${text}`);
    }

    return (await response.json()) as GenerationStatusResponse;
}

// Submit a text-to-image generation via the flux-2 endpoint.
export async function submitImageGeneration(
    apiKey: string,
    apiSecret: string,
    prompt: string,
    params: Record<string, unknown> = {},
): Promise<string> {
    const body = {
        prompt,
        image_urls: params.image_urls ?? [],
        resolution: params.resolution ?? "1k",
        aspect_ratio: params.aspect_ratio ?? "4:3",
        prompt_upsampling: params.prompt_upsampling ?? true,
    };

    const response = await fetch(`${HIGGSFIELD_BASE_URL}/flux-2`, {
        method: "POST",
        headers: hfHeaders(apiKey, apiSecret),
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Higgsfield image submit error ${response.status}: ${text}`,
        );
    }

    const data = (await response.json()) as SubmitResponse;
    if (!data.request_id) throw new Error("Higgsfield returned no request_id");

    return data.request_id;
}

export interface MultiPromptSegment {
    duration: number;
    prompt: string;
}

export async function submitVideoGeneration(
    apiKey: string,
    apiSecret: string,
    prompt: string,
    params: Record<string, unknown> = {},
): Promise<string> {
    const body = {
        params: {
            sound: "on",
            prompt,
            duration: params.duration ?? 5,
            elements: [],
            cfg_scale: params.cfg_scale ?? 0.5,
            multi_shots: false,
            aspect_ratio: params.aspect_ratio ?? "16:9",
            multi_prompt: (params.multi_prompt as MultiPromptSegment[]) ?? [],
        },
    };

    const response = await fetch(
        `${HIGGSFIELD_BASE_URL}/generate/kling-video/v3.0/std/text-to-video`,
        {
            method: "POST",
            headers: hfHeaders(apiKey, apiSecret),
            body: JSON.stringify(body),
        },
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `Higgsfield video submit error ${response.status}: ${text}`,
        );
    }

    const data = (await response.json()) as KlingVideoSubmitResponse;
    if (!data.id) throw new Error("Kling Video returned no id");

    return data.id;
}

export async function submitImageToVideoGeneration(
	apiKey: string,
	apiSecret: string,
	model: string,
	prompt: string,
	imageBase64: string,
	mimeType: string,
	params: Record<string, unknown> = {},
): Promise<string> {
	const path = model.startsWith('/') ? model : `/${model}`
	const body = {
		prompt,
		image: imageBase64,
		mime_type: mimeType,
		sound: params.sound ?? 'on',
		duration: params.duration ?? 6,
		aspect_ratio: params.aspect_ratio ?? '16:9',
		...params,
	}

	const response = await fetch(`${HIGGSFIELD_BASE_URL}${path}`, {
		method: 'POST',
		headers: hfHeaders(apiKey, apiSecret),
		body: JSON.stringify(body),
	})

	if (!response.ok) {
		const text = await response.text()
		console.warn('[higgsfield] image->video request failed body:', body)
		throw new Error(`Higgsfield image->video submit error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as SubmitResponse
	if (!data.request_id) {
		console.warn('[higgsfield] image->video response missing request_id:', data)
		console.warn('[higgsfield] sent body:', body)
		throw new Error('Higgsfield returned no request_id')
	}

	return data.request_id
}

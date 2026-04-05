import {
    OPENROUTER_BASE_URL,
    CLAUDE_MAX_TOKENS,
    AGENT_SYSTEM_PROMPT,
    VOICE_COMMAND_SYSTEM_PROMPT,
    REORGANIZE_SYSTEM_PROMPT,
    BRAINSTORM_SYSTEM_PROMPT,
    AUTONOMOUS_AGENT_SYSTEM_PROMPT,
    DESCRIBE_IMAGE_FOR_VIDEO_PROMPT,
} from "../config";

interface OpenRouterResponse {
    choices: { message: { content: string } }[];
}

export interface AgentAction {
    type:
        | "sticky"
        | "comment"
        | "connect"
        | "group"
        | "generate_image"
        | "generate_video";
    content?: string;
    color?: string;
    x?: number;
    y?: number;
    fromId?: string;
    toId?: string;
    label?: string;
    ids?: string[];
    prompt?: string;
}

export interface AgentResponse {
    synthesis: string;
    actions: AgentAction[];
}

export type VoiceCommandClassification =
    | AgentAction
    | { type: "analyze"; message?: string }
    | {
          type: "image" | "video";
          prompt: string;
          params: Record<string, unknown>;
          referenceImageId?: string | null;
      };

// Sends a canvas screenshot to Claude via OpenRouter and returns a single
// image generation prompt to pass to Higgsfield.
export async function generateBrainstormPrompt(
    apiKey: string,
    model: string,
    imageBase64: string,
    mimeType: string,
): Promise<string> {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            max_tokens: CLAUDE_MAX_TOKENS,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${imageBase64}`,
                            },
                        },
                        {
                            type: "text",
                            text: BRAINSTORM_SYSTEM_PROMPT,
                        },
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) throw new Error("OpenRouter returned empty response");

    return content;
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
): Promise<AgentResponse> {
    const textContent = message
        ? `${serializedCanvas}\n\nUser message: ${message}`
        : serializedCanvas;

    const userContent: unknown[] = [];

    if (image && mimeType) {
        userContent.push({
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${image}` },
        });
    }

    userContent.push({ type: "text", text: textContent });

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            max_tokens: CLAUDE_MAX_TOKENS,
            messages: [
                { role: "system", content: AGENT_SYSTEM_PROMPT },
                { role: "user", content: userContent },
            ],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) throw new Error("OpenRouter returned empty response");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Claude did not return JSON: ${content}`);
    return JSON.parse(jsonMatch[0]) as AgentResponse;
}

export interface ReorganizeShape {
    id: string;
    type: string;
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface ReorganizeMove {
    id: string;
    x: number;
    y: number;
}

// Sends canvas shapes to Claude and returns new x,y positions for each shape.
export async function reorganizeLayout(
    apiKey: string,
    model: string,
    shapes: ReorganizeShape[],
    container: { w: number; h: number },
): Promise<{ reasoning: string; moves: ReorganizeMove[] }> {
    const userMessage = JSON.stringify({ container, shapes });

    console.log("[reorganize] prompt to Claude:\n", userMessage);

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            max_tokens: 2048,
            messages: [
                { role: "system", content: REORGANIZE_SYSTEM_PROMPT },
                { role: "user", content: userMessage },
            ],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error("OpenRouter returned empty response");

    console.log("[reorganize] Claude response:\n", raw);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Claude did not return JSON: ${raw}`);

    return JSON.parse(jsonMatch[0]) as {
        reasoning: string;
        moves: ReorganizeMove[];
    };
}

// Classifies a voice command as image or video generation and extracts the prompt + params.
// Optionally accepts canvas context (describing images on the canvas) so the AI can
// understand references like "this image" or "these superheroes in the image".
export async function classifyVoiceCommand(
    apiKey: string,
    model: string,
    command: string,
    canvasContext?: string,
): Promise<VoiceCommandClassification> {
    let userMessage = command;
    if (canvasContext) {
        userMessage = `${command}\n\n--- CANVAS CONTEXT ---\n${canvasContext}`;
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            max_tokens: CLAUDE_MAX_TOKENS,
            messages: [
                { role: "system", content: VOICE_COMMAND_SYSTEM_PROMPT },
                { role: "user", content: userMessage },
            ],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error("OpenRouter returned empty response");

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`OpenRouter did not return JSON: ${raw}`);

    return JSON.parse(jsonMatch[0]) as VoiceCommandClassification;
}

/**
 * Sends a canvas image to OpenRouter (Claude vision) to get a detailed visual
 * description. This description is then folded into the generation prompt so
 * the video generator understands the content the user is referring to.
 */
export async function describeCanvasImage(
    apiKey: string,
    model: string,
    imageBase64: string,
    mimeType: string,
    userIntent?: string,
): Promise<string> {
    const textPart = userIntent
        ? `Describe this image in detail. The user wants to: "${userIntent}". Focus on the visual elements most relevant to their intent.`
        : "Describe this image in detail.";

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            max_tokens: 512,
            messages: [
                { role: "system", content: DESCRIBE_IMAGE_FOR_VIDEO_PROMPT },
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${imageBase64}`,
                            },
                        },
                        { type: "text", text: textPart },
                    ],
                },
            ],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter image describe error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("OpenRouter returned empty image description");

    return content;
}

export interface AutonomousAgentResponse {
    shouldContribute: boolean;
    synthesis: string;
    actions: AgentAction[];
}

export async function invokeAutonomousAgent(
    apiKey: string,
    model: string,
    serializedCanvas: string,
    agentHistory: string[],
): Promise<AutonomousAgentResponse> {
    let userText = serializedCanvas;

    if (agentHistory.length > 0) {
        userText += `\n\n## YOUR RECENT ACTIONS (do not repeat these)\n${agentHistory.join("\n")}`;
    }

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            max_tokens: CLAUDE_MAX_TOKENS,
            messages: [
                { role: "system", content: AUTONOMOUS_AGENT_SYSTEM_PROMPT },
                { role: "user", content: userText },
            ],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenRouter error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) throw new Error("OpenRouter returned empty response");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
        throw new Error(`Autonomous agent did not return JSON: ${content}`);

    const parsed = JSON.parse(jsonMatch[0]) as AutonomousAgentResponse;
    return {
        shouldContribute: parsed.shouldContribute ?? false,
        synthesis: parsed.synthesis ?? "",
        actions: parsed.actions ?? [],
    };
}

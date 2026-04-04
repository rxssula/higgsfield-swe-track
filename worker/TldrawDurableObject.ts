import {
    DurableObjectSqliteSyncWrapper,
    SQLiteSyncStorage,
    TLSocketRoom,
} from "@tldraw/sync-core";
import {
    createTLSchema,
    // defaultBindingSchemas,
    defaultShapeSchemas,
    TLRecord,
} from "@tldraw/tlschema";
import { DurableObject } from "cloudflare:workers";
import { AutoRouter, error, IRequest } from "itty-router";
import { serializeCanvasState } from "../src/canvas/serializer";
import type { CanvasSnapshot } from "../src/canvas/types";
import {
    invokeAgent,
    generateBrainstormPrompt,
    classifyVoiceCommand,
} from "../src/agent/claude";
import {
    submitGeneration,
    pollUntilDone,
    submitImageGeneration,
    submitVideoGeneration,
    pollUntilDoneWithType,
} from "../src/higgsfield/client";

// add custom shapes and bindings here if needed:
const schema = createTLSchema({
    shapes: { ...defaultShapeSchemas },
    // bindings: { ...defaultBindingSchemas },
});

// Each whiteboard room is hosted in a Durable Object.
// https://developers.cloudflare.com/durable-objects/
//
// There's only ever one durable object instance per room. Room state is
// persisted automatically to SQLite via ctx.storage.
export class TldrawDurableObject extends DurableObject<Env> {
    private room: TLSocketRoom<TLRecord, void>;
    private voiceSessions = new Map<string, WebSocket>();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        const sql = new DurableObjectSqliteSyncWrapper(ctx.storage);
        const storage = new SQLiteSyncStorage<TLRecord>({ sql });
        this.room = new TLSocketRoom<TLRecord, void>({ schema, storage });
    }

    private readonly router = AutoRouter({ catch: (e) => error(e) })
        .get("/api/connect/:roomId", (request) => this.handleConnect(request))
        .post("/api/agent/run", (request) => this.handleAgentRun(request))
        // .post("/api/agent/brainstorm", (request) => this.handleAgentBrainstorm(request))
        .post("/api/agent/voice-command", (request) =>
            this.handleVoiceCommand(request),
        )
        .get("/api/voice/:roomId", (request) =>
            this.handleVoiceConnect(request),
        );

    fetch(request: Request): Response | Promise<Response> {
        return this.router.fetch(request);
    }

    async handleConnect(request: IRequest) {
        const sessionId = request.query.sessionId as string;
        if (!sessionId) return error(400, "Missing sessionId");

        const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
        serverWebSocket.accept();
        this.room.handleSocketConnect({ sessionId, socket: serverWebSocket });

        return new Response(null, { status: 101, webSocket: clientWebSocket });
    }

    // Receives the agent invocation from worker.ts, kicks off the pipeline
    // async and returns immediately — results are pushed via WebSocket.
    async handleAgentRun(request: IRequest) {
        console.log("[handleAgentRun] received");
        const body = (await request.json()) as {
            shapes?: unknown[];
            bindings?: unknown[];
            message?: string;
            mode?: string;
            image?: string;
            mimeType?: string;
        };

        this.ctx.waitUntil(
            this.runAgentPipeline(
                body.shapes ?? [],
                body.bindings ?? [],
                body.message,
                body.mode,
                body.image,
                body.mimeType,
            ),
        );

        return Response.json({ ok: true });
    }

    // Broadcasts a message to every connected session in the room.
    private broadcast(data: object) {
        for (const session of this.room.getSessions()) {
            this.room.sendCustomMessage(session.sessionId, data);
        }
    }

    // Runs the full agent pipeline: serialize → Claude → Higgsfield → broadcast result.
    private async runAgentPipeline(
        shapes: unknown[],
        bindings: unknown[],
        message?: string,
        _mode?: string,
        image?: string,
        mimeType?: string,
    ) {
        console.log(
            "[pipeline] start, shapes:",
            shapes.length,
            "hasImage:",
            !!image,
        );
        try {
            this.broadcast({
                type: "agent:status",
                status: "Reading canvas...",
            });
            const snapshot: CanvasSnapshot = {
                shapes: shapes as any,
                bindings: bindings as any,
            };
            const serialized = serializeCanvasState(snapshot);
            console.log("[pipeline] serialized canvas:\n", serialized);

            this.broadcast({
                type: "agent:status",
                status: "Generating prompt...",
            });
            const replyRaw = await invokeAgent(
                this.env.OPENROUTER_API_KEY,
                this.env.OPENROUTER_MODEL,
                serialized,
                message,
                image,
                mimeType,
            );
            console.log("[pipeline] claude reply:", replyRaw);
            // Extract JSON even if Claude wraps it in markdown code fences or prose
            const jsonMatch = replyRaw.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                throw new Error(`Claude did not return JSON: ${replyRaw}`);
            const { synthesis, prompt } = JSON.parse(jsonMatch[0]);

            this.broadcast({
                type: "agent:status",
                status: "Rendering image...",
            });
            const requestId = await submitGeneration(
                this.env.HIGGSFIELD_API_KEY,
                this.env.HIGGSFIELD_API_SECRET,
                this.env.HIGGSFIELD_MODEL,
                prompt,
            );
            console.log("[pipeline] higgsfield requestId:", requestId);
            const imageUrl = await pollUntilDone(
                this.env.HIGGSFIELD_API_KEY,
                this.env.HIGGSFIELD_API_SECRET,
                requestId,
            );
            console.log("[pipeline] done, imageUrl:", imageUrl);

            this.broadcast({ type: "agent:done", imageUrl, synthesis, prompt });
        } catch (e) {
            console.error("[pipeline] error:", e);
            this.broadcast({ type: "agent:error", message: String(e) });
        }
    }

    // Runs the brainstorm pipeline: screenshot → Claude Vision → Higgsfield → broadcast result.
    // private async runBrainstormPipeline(image: string, mimeType: string) {
    //     console.log("[brainstorm-pipeline] start");
    //     try {
    //         this.broadcast({
    //             type: "agent:status",
    //             status: "Analyzing screenshot...",
    //         });
    //         const replyRaw = await generateBrainstormPrompt(
    //             this.env.OPENROUTER_API_KEY,
    //             this.env.OPENROUTER_MODEL,
    //             image,
    //             mimeType,
    //         );
    //         console.log("[brainstorm-pipeline] claude reply:", replyRaw);

    //         const jsonMatch = replyRaw.match(/\{[\s\S]*\}/);
    //         if (!jsonMatch)
    //             throw new Error(`Claude did not return JSON: ${replyRaw}`);
    //         const { synthesis, prompt } = JSON.parse(jsonMatch[0]);

    //         this.broadcast({
    //             type: "agent:status",
    //             status: "Rendering image...",
    //         });
    //         const requestId = await submitGeneration(
    //             this.env.HIGGSFIELD_API_KEY,
    //             this.env.HIGGSFIELD_API_SECRET,
    //             this.env.HIGGSFIELD_MODEL,
    //             prompt,
    //         );
    //         console.log(
    //             "[brainstorm-pipeline] higgsfield requestId:",
    //             requestId,
    //         );
    //         const imageUrl = await pollUntilDone(
    //             this.env.HIGGSFIELD_API_KEY,
    //             this.env.HIGGSFIELD_API_SECRET,
    //             requestId,
    //         );
    //         console.log("[brainstorm-pipeline] done, imageUrl:", imageUrl);

    //         this.broadcast({ type: "agent:done", imageUrl, synthesis, prompt });
    //     } catch (e) {
    //         console.error("[brainstorm-pipeline] error:", e);
    //         this.broadcast({ type: "agent:error", message: String(e) });
    //     }
    // }

    async handleVoiceCommand(request: IRequest) {
        console.log("[handleVoiceCommand] received");
        const body = (await request.json()) as { command: string };

        this.ctx.waitUntil(this.runVoiceCommandPipeline(body.command));

        return Response.json({ ok: true });
    }

    // Runs the voice command pipeline: classify → generate image or video → broadcast result.
    private async runVoiceCommandPipeline(command: string) {
        console.log("[voice-pipeline] start, command:", command);
        try {
            this.broadcast({
                type: "agent:status",
                status: "Understanding your request...",
            });

            const classification = await classifyVoiceCommand(
                this.env.OPENROUTER_API_KEY,
                this.env.OPENROUTER_MODEL,
                command,
            );
            console.log(
                "[voice-pipeline] classification:",
                JSON.stringify(classification),
            );

            let requestId: string;

            if (classification.type === "video") {
                this.broadcast({
                    type: "agent:status",
                    status: "Generating video...",
                });
                requestId = await submitVideoGeneration(
                    this.env.HIGGSFIELD_API_KEY,
                    this.env.HIGGSFIELD_API_SECRET,
                    classification.prompt,
                    classification.params,
                );
            } else {
                this.broadcast({
                    type: "agent:status",
                    status: "Generating image...",
                });
                requestId = await submitImageGeneration(
                    this.env.HIGGSFIELD_API_KEY,
                    this.env.HIGGSFIELD_API_SECRET,
                    classification.prompt,
                    classification.params,
                );
            }

            console.log("[voice-pipeline] higgsfield requestId:", requestId);

            const result = await pollUntilDoneWithType(
                this.env.HIGGSFIELD_API_KEY,
                this.env.HIGGSFIELD_API_SECRET,
                requestId,
            );
            console.log(
                "[voice-pipeline] done, url:",
                result.url,
                "type:",
                result.mediaType,
            );

            this.broadcast({
                type: "agent:done",
                imageUrl: result.mediaType === "image" ? result.url : undefined,
                videoUrl: result.mediaType === "video" ? result.url : undefined,
                mediaType: result.mediaType,
                synthesis: `Generated ${result.mediaType} from voice command: "${command}"`,
                prompt: classification.prompt,
            });
        } catch (e) {
            console.error("[voice-pipeline] error:", e);
            this.broadcast({ type: "agent:error", message: String(e) });
        }
    }

    // ── Voice chat signaling ──

    async handleVoiceConnect(request: IRequest) {
        const sessionId = request.query.sessionId as string;
        if (!sessionId) return error(400, "Missing sessionId");

        const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
        serverWebSocket.accept();

        const currentPeers = Array.from(this.voiceSessions.keys());
        serverWebSocket.send(
            JSON.stringify({ type: "voice-peers", peers: currentPeers }),
        );

        this.voiceSessions.set(sessionId, serverWebSocket);
        this.broadcastVoice({ type: "voice-join", sessionId }, sessionId);

        serverWebSocket.addEventListener("message", (event) => {
            try {
                const msg = JSON.parse(event.data as string);

                if (msg.type === "voice-leave") {
                    this.voiceSessions.delete(sessionId);
                    this.broadcastVoice({ type: "voice-leave", sessionId });
                    serverWebSocket.close();
                    return;
                }

                if (msg.to) {
                    const target = this.voiceSessions.get(msg.to);
                    if (target && target.readyState === 1) {
                        target.send(JSON.stringify(msg));
                    }
                }
            } catch {
                /* ignore malformed messages */
            }
        });

        serverWebSocket.addEventListener("close", () => {
            this.voiceSessions.delete(sessionId);
            this.broadcastVoice({ type: "voice-leave", sessionId });
        });

        serverWebSocket.addEventListener("error", () => {
            this.voiceSessions.delete(sessionId);
            this.broadcastVoice({ type: "voice-leave", sessionId });
        });

        return new Response(null, { status: 101, webSocket: clientWebSocket });
    }

    private broadcastVoice(msg: object, excludeId?: string) {
        const data = JSON.stringify(msg);
        for (const [id, socket] of this.voiceSessions) {
            if (id === excludeId) continue;
            if (socket.readyState === 1) {
                socket.send(data);
            }
        }
    }
}

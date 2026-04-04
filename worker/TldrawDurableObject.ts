import {
    DurableObjectSqliteSyncWrapper,
    SQLiteSyncStorage,
    TLSocketRoom,
    type RoomSnapshot,
} from "@tldraw/sync-core";
import {
    createTLSchema,
    defaultShapeSchemas,
    TLRecord,
} from "@tldraw/tlschema";
import { DurableObject } from "cloudflare:workers";
import { AutoRouter, error, IRequest } from "itty-router";
import { serializeCanvasState } from "../src/canvas/serializer";
import type { CanvasSnapshot } from "../src/canvas/types";
import { invokeAgent, classifyVoiceCommand } from "../src/agent/claude";
import {
	submitGeneration,
	submitImageGeneration,
	submitVideoGeneration,
	submitImageToVideoGeneration,
	getGenerationStatus,
} from "../src/higgsfield/client";

interface StoredGeneration {
	generationId: string;
	status: "working" | "submitted" | "done" | "error";
	message?: string;
	synthesis?: string;
	prompt?: string;
	requestId?: string;
	imageUrl?: string;
	videoUrl?: string;
	mediaType?: "image" | "video";
	errorMessage?: string;
	createdAt: number;
}

interface HiggsfieldWebhookPayload {
    status: "completed" | "failed" | "nsfw";
    request_id?: string;
    requestId?: string;
    error?: string;
    images?: { url: string }[];
    image?: { url: string };
    video?: { url: string };
    videos?: { url: string }[];
}

export interface SnapshotMeta {
    id: string;
    label: string;
    trigger: string;
    created_at: number;
    shape_count: number;
}

const MAX_SNAPSHOTS = 50;

const schema = createTLSchema({
    shapes: { ...defaultShapeSchemas },
});

const GENERATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class TldrawDurableObject extends DurableObject<Env> {
    private room: TLSocketRoom<TLRecord, void>;
    private voiceSessions = new Map<string, WebSocket>();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        const sql = new DurableObjectSqliteSyncWrapper(ctx.storage);
        const storage = new SQLiteSyncStorage<TLRecord>({ sql });
        this.room = new TLSocketRoom<TLRecord, void>({ schema, storage });
        this.initSnapshotTable();
    }

    // ── Snapshot history ──

    private initSnapshotTable() {
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                trigger_type TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                snapshot_json TEXT NOT NULL,
                shape_count INTEGER DEFAULT 0
            )
        `);
    }

    private createSnapshot(label: string, trigger: string): SnapshotMeta {
        const id = crypto.randomUUID();
        const created_at = Date.now();
        const snapshot = this.room.getCurrentSnapshot();
        const snapshot_json = JSON.stringify(snapshot);
        const shape_count = snapshot.documents?.length ?? 0;

        this.ctx.storage.sql.exec(
            `INSERT INTO snapshots (id, label, trigger_type, created_at, snapshot_json, shape_count) VALUES (?, ?, ?, ?, ?, ?)`,
            id, label, trigger, created_at, snapshot_json, shape_count,
        );

        // Enforce cap
        this.ctx.storage.sql.exec(
            `DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY created_at DESC LIMIT ?)`,
            MAX_SNAPSHOTS,
        );

        const meta: SnapshotMeta = { id, label, trigger, created_at, shape_count };
        this.broadcast({ type: "history:snapshot-created", snapshot: meta });
        return meta;
    }

    private listSnapshots(): SnapshotMeta[] {
        const rows = this.ctx.storage.sql.exec(
            `SELECT id, label, trigger_type, created_at, shape_count FROM snapshots ORDER BY created_at DESC`,
        ).toArray();
        return rows.map((r: any) => ({
            id: r.id,
            label: r.label,
            trigger: r.trigger_type,
            created_at: r.created_at,
            shape_count: r.shape_count,
        }));
    }

    private getSnapshotData(id: string): RoomSnapshot | null {
        const rows = this.ctx.storage.sql.exec(
            `SELECT snapshot_json FROM snapshots WHERE id = ?`, id,
        ).toArray();
        if (rows.length === 0) return null;
        return JSON.parse(rows[0].snapshot_json as string);
    }

    private restoreSnapshot(id: string, mode: "fork" | "hard") {
        const snapshotData = this.getSnapshotData(id);
        if (!snapshotData) throw new Error("Snapshot not found");

        if (mode === "fork") {
            this.createSnapshot("Auto-save before restore", "auto");
        }

        this.room.loadSnapshot(snapshotData);

        if (mode === "hard") {
            const rows = this.ctx.storage.sql.exec(
                `SELECT created_at FROM snapshots WHERE id = ?`, id,
            ).toArray();
            if (rows.length > 0) {
                this.ctx.storage.sql.exec(
                    `DELETE FROM snapshots WHERE created_at > ?`, rows[0].created_at,
                );
            }
        }

        this.broadcast({ type: "history:restored", snapshotId: id, mode });
    }

    private async handleCreateSnapshot(request: IRequest) {
        const body = (await request.json().catch(() => ({}))) as { label?: string };
        const label = body.label || "Manual checkpoint";
        const meta = this.createSnapshot(label, "manual");
        return Response.json({ ok: true, snapshot: meta });
    }

    private handleListSnapshots(_request: IRequest) {
        return Response.json({ snapshots: this.listSnapshots() });
    }

    private handleGetSnapshot(request: IRequest) {
        const id = request.params.id;
        if (!id) return error(400, "Missing snapshot id");
        const data = this.getSnapshotData(id);
        if (!data) return error(404, "Snapshot not found");
        return Response.json({ snapshot: data });
    }

    private async handleRestoreSnapshot(request: IRequest) {
        const id = request.params.id;
        if (!id) return error(400, "Missing snapshot id");
        const body = (await request.json()) as { mode?: "fork" | "hard" };
        const mode = body.mode === "hard" ? "hard" : "fork";
        try {
            this.restoreSnapshot(id, mode);
            return Response.json({ ok: true });
        } catch (e) {
            return error(400, String(e));
        }
    }

    private readonly router = AutoRouter({ catch: (e) => error(e) })
        .get("/api/connect/:roomId", (request) => this.handleConnect(request))
        .post("/api/agent/run", (request) => this.handleAgentRun(request))
        .post("/api/higgsfield/webhook", (request) =>
            this.handleHiggsfieldWebhook(request),
        )
        .post("/api/agent/voice-command", (request) =>
            this.handleVoiceCommand(request),
        )
        .post("/api/agent/dismiss", (request) =>
            this.handleDismissGeneration(request),
        )
        .get("/api/voice/:roomId", (request) =>
            this.handleVoiceConnect(request),
        )
        // Snapshot history routes
        .post("/api/snapshots/create", (request) =>
            this.handleCreateSnapshot(request),
        )
        .get("/api/snapshots/list", (request) =>
            this.handleListSnapshots(request),
        )
        .get("/api/snapshots/:id", (request) =>
            this.handleGetSnapshot(request),
        )
        .post("/api/snapshots/:id/restore", (request) =>
            this.handleRestoreSnapshot(request),
        );

    fetch(request: Request): Response | Promise<Response> {
        return this.router.fetch(request);
    }

    // ── Connection ──

    async handleConnect(request: IRequest) {
        const sessionId = request.query.sessionId as string;
        if (!sessionId) return error(400, "Missing sessionId");

        const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
        serverWebSocket.accept();
        this.room.handleSocketConnect({ sessionId, socket: serverWebSocket });

        this.ctx.waitUntil(this.replayGenerations(sessionId));

        return new Response(null, { status: 101, webSocket: clientWebSocket });
    }

    // ── Broadcasting ──

    private broadcast(data: object) {
        for (const session of this.room.getSessions()) {
            this.room.sendCustomMessage(session.sessionId, data);
        }
    }

    // ── Generation storage ──

    private genKey(id: string) {
        return `gen:${id}`;
    }
    private reqMapKey(requestId: string) {
        return `gen:reqmap:${requestId}`;
    }
    private webhookQueueKey(requestId: string) {
        return `gen:webhook:${requestId}`;
    }

    private async storeGeneration(gen: StoredGeneration) {
        await this.ctx.storage.put(this.genKey(gen.generationId), gen);
    }

    private async getGeneration(id: string) {
        return this.ctx.storage.get<StoredGeneration>(this.genKey(id));
    }

    private async deleteGeneration(id: string) {
        await this.ctx.storage.delete(this.genKey(id));
    }

    private async getAllGenerations(): Promise<StoredGeneration[]> {
        const entries = await this.ctx.storage.list<StoredGeneration>({
            prefix: "gen:",
        });
        const now = Date.now();
        const results: StoredGeneration[] = [];
        const staleKeys: string[] = [];

        for (const [key, value] of entries) {
            if (
                key.startsWith("gen:reqmap:") ||
                key.startsWith("gen:webhook:")
            )
                continue;
            if (!value?.generationId) continue;

            if (now - value.createdAt > GENERATION_TTL_MS) {
                staleKeys.push(key);
                continue;
            }
            results.push(value);
        }

        if (staleKeys.length > 0) {
            await this.ctx.storage.delete(staleKeys);
        }

        return results;
    }

    // ── Replay on reconnect ──

    private async replayGenerations(sessionId: string) {
        await new Promise((r) => setTimeout(r, 200));

        const generations = await this.getAllGenerations();
        for (const gen of generations) {
            try {
                if (gen.status === "done") {
                    this.room.sendCustomMessage(sessionId, {
                        type: "agent:done",
                        generationId: gen.generationId,
                        imageUrl: gen.imageUrl,
                        videoUrl: gen.videoUrl,
                        mediaType: gen.mediaType,
                        synthesis: gen.synthesis,
                        prompt: gen.prompt,
                        replayed: true,
                    });
                } else if (gen.status === "error") {
                    this.room.sendCustomMessage(sessionId, {
                        type: "agent:error",
                        generationId: gen.generationId,
                        message: gen.errorMessage,
                    });
                } else if (
                    gen.status === "working" ||
                    gen.status === "submitted"
                ) {
                    this.room.sendCustomMessage(sessionId, {
                        type: "agent:status",
                        generationId: gen.generationId,
                        status: gen.message ?? "Generating...",
                    });
                }
            } catch {
                /* session may have disconnected */
            }
        }
    }

    // ── Webhook finalization ──

    private async finalizeGeneration(
        generationId: string,
        payload: HiggsfieldWebhookPayload,
    ) {
        const gen = await this.getGeneration(generationId);
        if (!gen || gen.status === "done" || gen.status === "error") return;

        if (payload.status === "completed") {
            const videoUrl = payload.video?.url ?? payload.videos?.[0]?.url;
            const imageUrl = payload.images?.[0]?.url ?? payload.image?.url;
            const mediaType =
                gen.mediaType ?? (videoUrl ? "video" : "image");
            const mediaUrl =
                mediaType === "video"
                    ? (videoUrl ?? imageUrl)
                    : (imageUrl ?? videoUrl);

            if (!mediaUrl) {
                await this.storeGeneration({
                    ...gen,
                    status: "error",
                    errorMessage: "Completed but no media URL returned",
                });
                this.broadcast({
                    type: "agent:error",
                    generationId,
                    message: "No media URL returned",
                });
                return;
            }

            const finalImageUrl =
                mediaType === "image" ? mediaUrl : undefined;
            const finalVideoUrl =
                mediaType === "video" ? mediaUrl : undefined;

            await this.storeGeneration({
                ...gen,
                status: "done",
                imageUrl: finalImageUrl,
                videoUrl: finalVideoUrl,
            });

            this.broadcast({
                type: "agent:done",
                generationId,
                imageUrl: finalImageUrl,
                videoUrl: finalVideoUrl,
                mediaType,
                synthesis: gen.synthesis,
                prompt: gen.prompt,
            });

            // Auto-snapshot after agent places media (delay for client sync)
            this.ctx.waitUntil(
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        try {
                            this.createSnapshot(
                                `AI: ${(gen.prompt ?? "generation").slice(0, 50)}`,
                                "agent",
                            );
                        } catch (e) {
                            console.error("[snapshot] auto-snapshot error:", e);
                        }
                        resolve();
                    }, 3000);
                }),
            );
        } else if (payload.status === "failed") {
            const msg = payload.error ?? "Higgsfield generation failed";
            await this.storeGeneration({
                ...gen,
                status: "error",
                errorMessage: msg,
            });
            this.broadcast({
                type: "agent:error",
                generationId,
                message: msg,
            });
        } else if (payload.status === "nsfw") {
            const msg = "Higgsfield rejected prompt (NSFW)";
            await this.storeGeneration({
                ...gen,
                status: "error",
                errorMessage: msg,
            });
            this.broadcast({
                type: "agent:error",
                generationId,
                message: msg,
            });
        }

        if (gen.requestId) {
            await this.ctx.storage.delete(this.reqMapKey(gen.requestId));
            await this.ctx.storage.delete(
                this.webhookQueueKey(gen.requestId),
            );
        }
    }

    // ── Status polling fallback ──

    private async pollForCompletion(
        generationId: string,
        requestId: string,
    ) {
        const POLL_INTERVAL_MS = 5_000;
        const MAX_POLLS = 120;

        for (let i = 0; i < MAX_POLLS; i++) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

            const gen = await this.getGeneration(generationId);
            if (!gen || gen.status === "done" || gen.status === "error") {
                return;
            }

            try {
                const status = await getGenerationStatus(
                    this.env.HIGGSFIELD_API_KEY,
                    this.env.HIGGSFIELD_API_SECRET,
                    requestId,
                );

                if (
                    status.status === "completed" ||
                    status.status === "failed" ||
                    status.status === "nsfw"
                ) {
                    console.log(
                        "[poll] generation complete, finalizing:",
                        generationId,
                    );
                    await this.finalizeGeneration(
                        generationId,
                        status as HiggsfieldWebhookPayload,
                    );
                    return;
                }
            } catch (e) {
                console.error("[poll] status check error:", e);
            }
        }

        const gen = await this.getGeneration(generationId);
        if (gen && gen.status !== "done" && gen.status !== "error") {
            await this.storeGeneration({
                ...gen,
                status: "error",
                errorMessage: "Generation timed out",
            });
            this.broadcast({
                type: "agent:error",
                generationId,
                message: "Generation timed out",
            });
        }
    }

    // ── Webhook handler ──

    private async handleHiggsfieldWebhook(request: IRequest) {
        const payload = (await request.json()) as HiggsfieldWebhookPayload;
        const requestId = payload.request_id ?? payload.requestId;
        if (!requestId) return error(400, "Missing request_id");

        const generationId = await this.ctx.storage.get<string>(
            this.reqMapKey(requestId),
        );
        if (!generationId) {
            console.log(
                "[higgsfield-webhook] no generation mapping yet, queueing for:",
                requestId,
            );
            await this.ctx.storage.put(
                this.webhookQueueKey(requestId),
                payload,
            );
            return Response.json({ ok: true });
        }

        console.log(
            "[higgsfield-webhook] finalizing generation:",
            generationId,
            "status:",
            payload.status,
        );
        await this.finalizeGeneration(generationId, payload);

        return Response.json({ ok: true });
    }

    // ── Dismiss handler ──

    private async handleDismissGeneration(request: IRequest) {
        const { generationId } = (await request.json()) as {
            generationId: string;
        };
        if (!generationId) return error(400, "Missing generationId");

        const gen = await this.getGeneration(generationId);
        if (gen) {
            if (gen.requestId) {
                await this.ctx.storage.delete(this.reqMapKey(gen.requestId));
                await this.ctx.storage.delete(
                    this.webhookQueueKey(gen.requestId),
                );
            }
            await this.deleteGeneration(generationId);
        }

        this.broadcast({ type: "agent:dismiss", generationId });

        return Response.json({ ok: true });
    }

    // ── Agent run ──

    async handleAgentRun(request: IRequest) {
        console.log("[handleAgentRun] received");
        const body = (await request.json()) as {
            shapes?: unknown[];
            bindings?: unknown[];
            message?: string;
            mode?: string;
            image?: string;
            mimeType?: string;
            webhookUrl?: string;
        };

        this.ctx.waitUntil(
            this.runAgentPipeline(
                body.shapes ?? [],
                body.bindings ?? [],
                body.message,
                body.mode,
                body.image,
                body.mimeType,
                body.webhookUrl,
            ),
        );

        return Response.json({ ok: true });
    }

    private async runAgentPipeline(
        shapes: unknown[],
        bindings: unknown[],
        message?: string,
        _mode?: string,
        image?: string,
        mimeType?: string,
        webhookUrl?: string,
    ) {
        const generationId = crypto.randomUUID();
        const createdAt = Date.now();
        console.log(
            "[pipeline] start, generationId:",
            generationId,
            "shapes:",
            shapes.length,
        );

        try {
            await this.storeGeneration({
                generationId,
                status: "working",
                message: "Reading canvas...",
                mediaType: "image",
                createdAt,
            });
            this.broadcast({
                type: "agent:status",
                generationId,
                status: "Reading canvas...",
            });

            const snapshot: CanvasSnapshot = {
                shapes: shapes as any,
                bindings: bindings as any,
            };
            const serialized = serializeCanvasState(snapshot);
            console.log("[pipeline] serialized canvas:\n", serialized);

            await this.storeGeneration({
                generationId,
                status: "working",
                message: "Generating prompt...",
                mediaType: "image",
                createdAt,
            });
            this.broadcast({
                type: "agent:status",
                generationId,
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
            const jsonMatch = replyRaw.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                throw new Error(`Claude did not return JSON: ${replyRaw}`);
            const parsed = JSON.parse(jsonMatch[0]) as {
                synthesis: string;
                prompt: string;
                mediaType?: "image" | "video";
            };
            const targetMedia =
                parsed.mediaType === "video" ? "video" : "image";
            const { synthesis, prompt } = parsed;

            const renderStatus =
                targetMedia === "video"
                    ? "Rendering video..."
                    : "Rendering image...";
            await this.storeGeneration({
                generationId,
                status: "working",
                message: renderStatus,
                synthesis,
                prompt,
                mediaType: targetMedia,
                createdAt,
            });
            this.broadcast({
                type: "agent:status",
                generationId,
                status: renderStatus,
            });

            let requestId: string;
            if (targetMedia === "video") {
                requestId = await this.submitVideoRequest(
                    prompt,
                    image,
                    mimeType,
                    webhookUrl,
                );
            } else {
                requestId = await submitGeneration(
                    this.env.HIGGSFIELD_API_KEY,
                    this.env.HIGGSFIELD_API_SECRET,
                    this.env.HIGGSFIELD_MODEL,
                    prompt,
                    { webhookUrl },
                );
            }
            console.log("[pipeline] higgsfield requestId:", requestId);

            await this.ctx.storage.put(
                this.reqMapKey(requestId),
                generationId,
            );
            await this.storeGeneration({
                generationId,
                status: "submitted",
                message: `Waiting for ${targetMedia} to generate...`,
                synthesis,
                prompt,
                requestId,
                mediaType: targetMedia,
                createdAt,
            });

            const earlyWebhook =
                await this.ctx.storage.get<HiggsfieldWebhookPayload>(
                    this.webhookQueueKey(requestId),
                );
            if (earlyWebhook) {
                console.log("[pipeline] found early webhook, finalizing");
                await this.finalizeGeneration(generationId, earlyWebhook);
                await this.ctx.storage.delete(
                    this.webhookQueueKey(requestId),
                );
            } else {
                this.broadcast({
                    type: "agent:status",
                    generationId,
                    status: `Waiting for ${targetMedia} to generate...`,
                });
                this.ctx.waitUntil(
                    this.pollForCompletion(generationId, requestId),
                );
            }
        } catch (e) {
            console.error("[pipeline] error:", e);
            await this.storeGeneration({
                generationId,
                status: "error",
                errorMessage: String(e),
                createdAt,
            });
            this.broadcast({
                type: "agent:error",
                generationId,
                message: String(e),
            });
		}
	}

	private async submitVideoRequest(
		prompt: string,
		image?: string,
		mimeType?: string,
		webhookUrl?: string,
	): Promise<string> {
		if (
			image &&
			mimeType &&
			this.env.HIGGSFIELD_MODEL_IMAGE_TO_TEXT
		) {
			try {
				return await submitImageToVideoGeneration(
					this.env.HIGGSFIELD_API_KEY,
					this.env.HIGGSFIELD_API_SECRET,
					this.env.HIGGSFIELD_MODEL_IMAGE_TO_TEXT,
					prompt,
					image,
					mimeType,
					{},
					{ webhookUrl },
				);
			} catch (error) {
				console.warn(
					"[pipeline] image->video submission failed, falling back",
					error,
				);
			}
		}

		return submitVideoGeneration(
			this.env.HIGGSFIELD_API_KEY,
			this.env.HIGGSFIELD_API_SECRET,
			prompt,
			{},
			{ webhookUrl },
		);
	}

	// ── Voice command ──

    async handleVoiceCommand(request: IRequest) {
        console.log("[handleVoiceCommand] received");
        const body = (await request.json()) as {
            command: string;
            webhookUrl?: string;
        };

        this.ctx.waitUntil(
            this.runVoiceCommandPipeline(body.command, body.webhookUrl),
        );

        return Response.json({ ok: true });
    }

    private async runVoiceCommandPipeline(
        command: string,
        webhookUrl?: string,
    ) {
        const generationId = crypto.randomUUID();
        const createdAt = Date.now();
        console.log(
            "[voice-pipeline] start, generationId:",
            generationId,
            "command:",
            command,
        );

        try {
            await this.storeGeneration({
                generationId,
                status: "working",
                message: "Understanding your request...",
                createdAt,
            });
            this.broadcast({
                type: "agent:status",
                generationId,
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

            const mediaType = classification.type as "image" | "video";
            const synthesis = `Generated ${mediaType} from voice command: "${command}"`;
            let requestId: string;

            if (classification.type === "video") {
                await this.storeGeneration({
                    generationId,
                    status: "working",
                    message: "Generating video...",
                    synthesis,
                    prompt: classification.prompt,
                    mediaType: "video",
                    createdAt,
                });
                this.broadcast({
                    type: "agent:status",
                    generationId,
                    status: "Generating video...",
                });
                requestId = await submitVideoGeneration(
                    this.env.HIGGSFIELD_API_KEY,
                    this.env.HIGGSFIELD_API_SECRET,
                    classification.prompt,
                    classification.params,
                    { webhookUrl },
                );
            } else {
                await this.storeGeneration({
                    generationId,
                    status: "working",
                    message: "Generating image...",
                    synthesis,
                    prompt: classification.prompt,
                    mediaType: "image",
                    createdAt,
                });
                this.broadcast({
                    type: "agent:status",
                    generationId,
                    status: "Generating image...",
                });
                requestId = await submitImageGeneration(
                    this.env.HIGGSFIELD_API_KEY,
                    this.env.HIGGSFIELD_API_SECRET,
                    classification.prompt,
                    classification.params,
                    { webhookUrl },
                );
            }

            console.log("[voice-pipeline] higgsfield requestId:", requestId);

            await this.ctx.storage.put(
                this.reqMapKey(requestId),
                generationId,
            );
            await this.storeGeneration({
                generationId,
                status: "submitted",
                message: `Waiting for ${mediaType} to generate...`,
                synthesis,
                prompt: classification.prompt,
                requestId,
                mediaType,
                createdAt,
            });

            const earlyWebhook =
                await this.ctx.storage.get<HiggsfieldWebhookPayload>(
                    this.webhookQueueKey(requestId),
                );
            if (earlyWebhook) {
                console.log(
                    "[voice-pipeline] found early webhook, finalizing",
                );
                await this.finalizeGeneration(generationId, earlyWebhook);
                await this.ctx.storage.delete(
                    this.webhookQueueKey(requestId),
                );
            } else {
                this.broadcast({
                    type: "agent:status",
                    generationId,
                    status: `Waiting for ${mediaType} to generate...`,
                });
                this.ctx.waitUntil(
                    this.pollForCompletion(generationId, requestId),
                );
            }
        } catch (e) {
            console.error("[voice-pipeline] error:", e);
            await this.storeGeneration({
                generationId,
                status: "error",
                errorMessage: String(e),
                createdAt,
            });
            this.broadcast({
                type: "agent:error",
                generationId,
                message: String(e),
            });
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

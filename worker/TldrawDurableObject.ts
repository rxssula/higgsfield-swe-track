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
import { serializeCanvasState, extractCanvasImages, serializeCanvasImagesContext } from "../src/canvas/serializer";
import type { CanvasSnapshot, CanvasShape, CanvasBinding, CanvasAsset } from "../src/canvas/types";
import { invokeAgent, invokeAutonomousAgent, classifyVoiceCommand, describeCanvasImage, reorganizeLayout, type ReorganizeShape } from "../src/agent/claude";
import type {
	AgentAction as ClaudeAgentAction,
	VoiceCommandClassification,
} from "../src/agent/claude";
import {
	createNoteRecord,
	createArrowRecord,
	createArrowBindingRecord,
	createFrameRecord,
	generateIndices,
	findHighestIndex,
} from "../src/canvas/shapeFactory";
import {
	AUTONOMOUS_AGENT_COOLDOWN_MS,
	AUTONOMOUS_AGENT_DEBOUNCE_MS,
	AUTONOMOUS_AGENT_MIN_SHAPES,
	AUTONOMOUS_AGENT_MAX_HISTORY,
} from "../src/config";
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
    id?: string;
    request_id?: string;
    requestId?: string;
    error?: string;
    images?: { url: string }[];
    image?: { url: string };
    video?: { url: string };
    videos?: { url: string }[];
    jobs?: {
        id?: string;
        status?: string;
        results?: {
            videos?: { url: string }[];
            video_url?: string;
            images?: { url: string }[];
            image_url?: string;
        };
        result?: {
            videos?: { url: string }[];
            video_url?: string;
            images?: { url: string }[];
            image_url?: string;
        };
    }[];
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

function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
}

export class TldrawDurableObject extends DurableObject<Env> {
    private room: TLSocketRoom<TLRecord, void>;
    private storage: SQLiteSyncStorage<TLRecord>;
    private voiceSessions = new Map<string, WebSocket>();
    private voiceUsernames = new Map<string, string>();

    // Autonomous agent state
    private agentEnabled = false;
    private agentRunning = false;
    private lastAgentRunAt = 0;
    private agentDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private agentActionHistory: string[] = [];
    private lastCanvasHash = "";

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        const sql = new DurableObjectSqliteSyncWrapper(ctx.storage);
        this.storage = new SQLiteSyncStorage<TLRecord>({ sql });
        this.room = new TLSocketRoom<TLRecord, void>({ schema, storage: this.storage });
        this.initSnapshotTable();
        this.restoreAgentMode();
    }

    // ── Autonomous agent ──

    private async restoreAgentMode() {
        const mode = await this.ctx.storage.get<string>("agent:mode");
        if (mode === "autonomous") {
            this.agentEnabled = true;
            const history = await this.ctx.storage.get<string[]>("agent:history");
            if (history) this.agentActionHistory = history;
            this.startAgentWatcher();
        }
    }

    private startAgentWatcher() {
        this.storage.onChange(({ id }) => {
            if (id === "agent-action") return;
            if (!this.agentEnabled) return;
            this.scheduleAgentRun();
        });
    }

    private scheduleAgentRun() {
        if (this.agentDebounceTimer) clearTimeout(this.agentDebounceTimer);
        this.agentDebounceTimer = setTimeout(() => {
            this.agentDebounceTimer = null;
            this.ctx.waitUntil(this.runAutonomousAgent());
        }, AUTONOMOUS_AGENT_DEBOUNCE_MS);
    }

    private async runAutonomousAgent() {
        if (!this.agentEnabled || this.agentRunning) return;

        const now = Date.now();
        if (now - this.lastAgentRunAt < AUTONOMOUS_AGENT_COOLDOWN_MS) return;

        this.agentRunning = true;
        try {
            const snapshot = this.buildRoomCanvasSnapshot();
            const userShapes = snapshot.shapes.filter(
                (s) => !(s.props as Record<string, unknown>)?.aiGenerated &&
                       s.type !== "arrow",
            );
            if (userShapes.length < AUTONOMOUS_AGENT_MIN_SHAPES) return;

            const serialized = serializeCanvasState(snapshot);
            const hash = simpleHash(serialized);
            if (hash === this.lastCanvasHash) return;

            this.broadcast({ type: "agent:thinking", thinking: true });

            const result = await invokeAutonomousAgent(
                this.env.OPENROUTER_API_KEY,
                this.env.OPENROUTER_MODEL,
                serialized,
                this.agentActionHistory,
            );

            this.lastCanvasHash = hash;
            this.lastAgentRunAt = Date.now();

            const mediaAction = getMediaAction(result.actions);
            const canvasActions = (result.actions ?? []).filter(
                (a) =>
                    a.type === "sticky" ||
                    a.type === "comment" ||
                    a.type === "connect" ||
                    a.type === "group",
            );
            const maxCanvas = mediaAction ? 2 : 3;
            const canvasToApply = canvasActions.slice(0, maxCanvas);
            const hasWork =
                result.shouldContribute &&
                (canvasToApply.length > 0 || !!mediaAction);

            if (!hasWork) {
                this.broadcast({ type: "agent:thinking", thinking: false });
                return;
            }

            if (canvasToApply.length > 0) {
                await this.applyAgentActionsToStore(canvasToApply, snapshot);
                this.broadcastCanvasActions(canvasToApply, result.synthesis);
            }

            const webhookUrl =
                await this.ctx.storage.get<string>("agent:webhookUrl");
            if (mediaAction && webhookUrl) {
                this.ctx.waitUntil(
                    this.enqueueAutonomousMediaGeneration(
                        result.synthesis,
                        mediaAction,
                        webhookUrl,
                    ),
                );
            } else if (mediaAction && !webhookUrl) {
                console.warn(
                    "[autonomous-agent] media action but no webhookUrl; re-enable AI collaborator to refresh",
                );
            }

            const historyEntries: ClaudeAgentAction[] = [...canvasToApply];
            if (mediaAction) historyEntries.push(mediaAction);
            for (const action of historyEntries) {
                const desc =
                    `${action.type}: ${action.content || action.label || action.prompt || ""}`.slice(
                        0,
                        100,
                    );
                this.agentActionHistory.push(desc);
            }
            while (this.agentActionHistory.length > AUTONOMOUS_AGENT_MAX_HISTORY) {
                this.agentActionHistory.shift();
            }
            await this.ctx.storage.put("agent:history", this.agentActionHistory);

            const actionCount =
                canvasToApply.length + (mediaAction ? 1 : 0);
            this.broadcast({
                type: "agent:contributed",
                synthesis: result.synthesis,
                actionCount,
                startedMedia: !!mediaAction,
            });
        } catch (e) {
            console.error("[autonomous-agent] error:", e);
        } finally {
            this.agentRunning = false;
            this.broadcast({ type: "agent:thinking", thinking: false });
        }
    }

    /** Higgsfield image/video job for autonomous agent (same lifecycle as runAgentPipeline media branch). */
    private async enqueueAutonomousMediaGeneration(
        synthesis: string,
        mediaAction: ClaudeAgentAction,
        webhookUrl: string,
    ) {
        const generationId = crypto.randomUUID();
        const createdAt = Date.now();
        const prompt = mediaAction.prompt?.trim() || synthesis;
        const targetMedia =
            mediaAction.type === "generate_video" ? "video" : "image";

        try {
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
                    undefined,
                    undefined,
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
            console.error("[autonomous-agent] media error:", e);
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

    private async applyAgentActionsToStore(
        actions: ClaudeAgentAction[],
        snapshot: CanvasSnapshot,
    ) {
        const existingRecords = this.room.getCurrentSnapshot().documents.map(
            (d) => d.state as unknown as Record<string, unknown>,
        );
        const highestIdx = findHighestIndex(existingRecords as any[]);
        const neededIndices = actions.reduce((n, a) => {
            if (
                a.type === "generate_image" ||
                a.type === "generate_video"
            ) {
                return n;
            }
            if (a.type === "connect") return n + 3; // arrow + 2 bindings
            if (a.type === "group") return n + 1;
            return n + 1;
        }, 0);
        const indices = generateIndices(neededIndices, highestIdx);
        let indexCursor = 0;

        await this.room.updateStore((store) => {
            for (const action of actions) {
                switch (action.type) {
                    case "sticky":
                    case "comment": {
                        const content = action.content?.trim();
                        if (!content) break;
                        const color = action.type === "comment"
                            ? (action.color ?? "light-gray")
                            : (action.color ?? "yellow");
                        const record = createNoteRecord({
                            content,
                            x: action.x ?? 0,
                            y: action.y ?? 0,
                            color,
                            index: indices[indexCursor++],
                        });
                        store.put(record as unknown as TLRecord);
                        break;
                    }
                    case "connect": {
                        const fromId = action.fromId;
                        const toId = action.toId;
                        if (!fromId || !toId) break;
                        const fromExists = snapshot.shapes.some((s) => s.id === fromId);
                        const toExists = snapshot.shapes.some((s) => s.id === toId);
                        if (!fromExists || !toExists) break;

                        const arrowRecord = createArrowRecord({
                            index: indices[indexCursor++],
                            label: action.label,
                        });
                        const arrowId = arrowRecord.id as string;
                        store.put(arrowRecord as unknown as TLRecord);

                        const startBinding = createArrowBindingRecord({
                            arrowId: arrowId as any,
                            targetId: fromId,
                            terminal: "start",
                            index: indices[indexCursor++],
                        });
                        store.put(startBinding as unknown as TLRecord);

                        const endBinding = createArrowBindingRecord({
                            arrowId: arrowId as any,
                            targetId: toId,
                            terminal: "end",
                            index: indices[indexCursor++],
                        });
                        store.put(endBinding as unknown as TLRecord);
                        break;
                    }
                    case "group": {
                        const ids = action.ids?.filter(Boolean) ?? [];
                        if (ids.length === 0) break;
                        const groupShapes = snapshot.shapes.filter((s) =>
                            ids.includes(s.id),
                        );
                        if (groupShapes.length === 0) break;

                        const minX = Math.min(...groupShapes.map((s) => s.x));
                        const minY = Math.min(...groupShapes.map((s) => s.y));
                        const maxX = Math.max(
                            ...groupShapes.map((s) =>
                                s.x + (typeof s.props?.w === "number" ? s.props.w : 200),
                            ),
                        );
                        const maxY = Math.max(
                            ...groupShapes.map((s) =>
                                s.y + (typeof s.props?.h === "number" ? s.props.h : 200),
                            ),
                        );
                        const padding = 80;
                        const frameRecord = createFrameRecord({
                            x: minX - padding / 2,
                            y: minY - padding / 2,
                            w: maxX - minX + padding,
                            h: maxY - minY + padding,
                            name: action.label?.trim() || "AI Group",
                            index: indices[indexCursor++],
                        });
                        store.put(frameRecord as unknown as TLRecord);
                        break;
                    }
                    default:
                        break;
                }
            }
        });
    }

    private async handleSetAgentMode(request: IRequest) {
        const body = (await request.json()) as {
            mode?: string;
            webhookUrl?: string;
        };
        const mode = body.mode === "autonomous" ? "autonomous" : "off";

        await this.ctx.storage.put("agent:mode", mode);

        if (mode === "autonomous") {
            if (body.webhookUrl) {
                await this.ctx.storage.put("agent:webhookUrl", body.webhookUrl);
            }
            this.agentEnabled = true;
            this.startAgentWatcher();
            this.scheduleAgentRun();
        } else {
            this.agentEnabled = false;
            await this.ctx.storage.delete("agent:webhookUrl");
            if (this.agentDebounceTimer) {
                clearTimeout(this.agentDebounceTimer);
                this.agentDebounceTimer = null;
            }
        }

        this.broadcast({ type: "agent:mode-changed", mode });
        return Response.json({ ok: true, mode });
    }

    private handleGetAgentMode() {
        return Response.json({
            mode: this.agentEnabled ? "autonomous" : "off",
        });
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
        .post("/api/agent/reorganize", (request) =>
            this.handleReorganize(request),
        )
        .post("/api/agent/set-mode", (request) =>
            this.handleSetAgentMode(request),
        )
        .get("/api/agent/mode", () => this.handleGetAgentMode())
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
            const videoUrl =
                payload.video?.url ??
                payload.videos?.[0]?.url ??
                payload.jobs?.[0]?.results?.videos?.[0]?.url ??
                payload.jobs?.[0]?.results?.video_url ??
                payload.jobs?.[0]?.result?.videos?.[0]?.url ??
                payload.jobs?.[0]?.result?.video_url;
            const imageUrl =
                payload.images?.[0]?.url ??
                payload.image?.url ??
                payload.jobs?.[0]?.results?.images?.[0]?.url ??
                payload.jobs?.[0]?.results?.image_url ??
                payload.jobs?.[0]?.result?.images?.[0]?.url ??
                payload.jobs?.[0]?.result?.image_url;
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
        const requestId = payload.request_id ?? payload.requestId ?? payload.id;
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
			const snapshot: CanvasSnapshot = {
				shapes: shapes as any,
				bindings: bindings as any,
			};
			const serialized = serializeCanvasState(snapshot);
			console.log("[pipeline] serialized canvas:\n", serialized);

			const agentResponse = await invokeAgent(
				this.env.OPENROUTER_API_KEY,
				this.env.OPENROUTER_MODEL,
				serialized,
				message,
				image,
				mimeType,
			);
			console.log("[pipeline] claude actions:", agentResponse);
			const mediaAction = getMediaAction(agentResponse.actions);
			const synthesis = agentResponse.synthesis;
			const canvasActions = agentResponse.actions?.filter((action) =>
				action.type === "sticky" ||
				action.type === "comment" ||
				action.type === "connect" ||
				action.type === "group",
			);
			this.broadcastCanvasActions(canvasActions, synthesis);
			if (!mediaAction) {
				console.log("[pipeline] no media action returned; exiting");
				return;
			}
			const prompt = mediaAction.prompt ?? synthesis;
			const targetMedia =
				mediaAction.type === "generate_video" ? "video" : "image";

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

	private broadcastCanvasActions(
		actions?: ClaudeAgentAction[],
		synthesis?: string,
	) {
		if (!actions || actions.length === 0) return;
		this.broadcast({
			type: "agent:actions",
			actions,
			synthesis,
		});
	}

	private buildRoomCanvasSnapshot(): CanvasSnapshot {
		const snapshot = this.room.getCurrentSnapshot();
		const shapes: CanvasShape[] = [];
		const bindings: CanvasBinding[] = [];
		const assets: CanvasAsset[] = [];

		for (const doc of snapshot.documents) {
			const record = doc.state as any;
			if (record.typeName === "shape") {
				shapes.push({
					id: record.id,
					type: record.type,
					x: record.x ?? 0,
					y: record.y ?? 0,
					rotation: record.rotation ?? 0,
					parentId: record.parentId ?? record.parent ?? "page:page",
					props: record.props ?? {},
					meta: record.meta ?? undefined,
				});
			} else if (record.typeName === "binding") {
				bindings.push({
					id: record.id,
					type: record.type,
					fromId: record.fromId,
					toId: record.toId,
					props:
						record.props ?? {
							terminal: "start",
							isExact: false,
							isPrecise: false,
							normalizedAnchor: { x: 0.5, y: 0.5 },
						},
				} as CanvasBinding);
			} else if (record.typeName === "asset") {
				assets.push({
					id: record.id,
					type: record.type,
					props: {
						name: record.props?.name,
						src: record.props?.src,
						w: record.props?.w,
						h: record.props?.h,
						mimeType: record.props?.mimeType,
						isAnimated: record.props?.isAnimated,
					},
				});
			}
		}

		return { shapes, bindings, assets };
	}

	// ── Reorganize layout ──

	async handleReorganize(request: IRequest) {
		const body = (await request.json()) as {
			shapes: ReorganizeShape[];
			container: { w: number; h: number };
		};

		if (!Array.isArray(body.shapes) || body.shapes.length === 0) {
			return error(400, "shapes array is required and must not be empty");
		}

		try {
			const result = await reorganizeLayout(
				this.env.OPENROUTER_API_KEY,
				this.env.OPENROUTER_MODEL,
				body.shapes,
				body.container,
			);
			return Response.json(result);
		} catch (e) {
			console.error("[reorganize] error:", e);
			return error(500, String(e));
		}
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

	/**
	 * Fetch a canvas image (from R2 bucket or external URL) and return it as base64.
	 * Handles both local asset paths (/api/uploads/...) and external URLs.
	 */
	private async fetchCanvasImageAsBase64(
		src: string,
	): Promise<{ imageBase64: string; mimeType: string }> {
		console.log("[fetchCanvasImage] src:", src);

		let imageData: ArrayBuffer;
		let mimeType: string;

		// Check if it's a local R2 asset path
		const uploadMatch = src.match(/\/api\/uploads\/(.+)$/);
		if (uploadMatch) {
			const objectName = uploadMatch[1];
			console.log("[fetchCanvasImage] fetching from R2:", objectName);

			const r2Object = await this.env.TLDRAW_BUCKET.get(objectName);
			if (!r2Object) {
				throw new Error(`Image not found in R2: ${objectName}`);
			}

			imageData = await r2Object.arrayBuffer();
			mimeType = r2Object.httpMetadata?.contentType ?? "image/png";
		} else {
			// External URL — fetch directly
			console.log("[fetchCanvasImage] fetching external URL:", src);
			const response = await fetch(src);
			if (!response.ok) {
				throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
			}
			imageData = await response.arrayBuffer();
			mimeType = response.headers.get("content-type") ?? "image/png";
		}

		// Convert ArrayBuffer to base64
		const bytes = new Uint8Array(imageData);
		let binary = "";
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		const imageBase64 = btoa(binary);

		console.log(
			"[fetchCanvasImage] success: size=",
			imageData.byteLength,
			"mimeType=",
			mimeType,
		);

		return { imageBase64, mimeType };
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

			// Build canvas context so the AI can understand references to canvas content
			const snapshot = this.buildRoomCanvasSnapshot();
			const canvasImages = extractCanvasImages(snapshot.shapes, snapshot.assets);
			const canvasContext = canvasImages.length > 0
				? serializeCanvasImagesContext(canvasImages)
				: undefined;

			console.log(
				"[voice-pipeline] canvas context: images=",
				canvasImages.length,
				canvasContext ? "context built" : "no images on canvas",
			);

			const classification = await classifyVoiceCommand(
				this.env.OPENROUTER_API_KEY,
				this.env.OPENROUTER_MODEL,
				command,
				canvasContext,
			);
			const normalized = normalizeVoiceClassification(classification);
			console.log(
				"[voice-pipeline] classification:",
				JSON.stringify(normalized),
			);

			if (normalized.kind === "canvas") {
				this.broadcastCanvasActions(
					[normalized.action],
					`Voice command: ${command}`,
				);
				return;
			}

			if (normalized.kind === "analyze") {
				await this.runAgentPipeline(
					snapshot.shapes,
					snapshot.bindings,
					normalized.message ?? command,
					undefined,
					undefined,
					webhookUrl,
				);
				return;
			}

			const prompt = normalized.prompt?.trim();
			if (!prompt) {
				throw new Error("Voice media request missing prompt");
			}
			const synthesis = `Generated ${normalized.mediaType} from voice command: "${command}"`;
			let requestId: string;

			// Check if the user referenced a canvas image (e.g. "generate trailer of these superheroes in the image")
			const referenceImageId = normalized.referenceImageId;
			const hasImageReference = !!referenceImageId;

			// If the user referenced a canvas image, send it to OpenRouter vision
			// to get a detailed description, then fold that into the prompt.
			let finalPrompt = prompt;
			if (hasImageReference) {
				console.log("[voice-pipeline] canvas image reference detected: referenceImageId=", referenceImageId);

				const refImage = canvasImages.find(img => img.shapeId === referenceImageId);
				if (!refImage?.src) {
					throw new Error(`Referenced image ${referenceImageId} not found or has no source URL`);
				}

				await this.storeGeneration({
					generationId,
					status: "working",
					message: "Analyzing canvas image...",
					synthesis,
					prompt,
					mediaType: normalized.mediaType,
					createdAt,
				});
				this.broadcast({
					type: "agent:status",
					generationId,
					status: "Analyzing canvas image...",
				});

				// Fetch the image and send to OpenRouter for visual understanding
				const { imageBase64, mimeType } = await this.fetchCanvasImageAsBase64(refImage.src);
				const imageDescription = await describeCanvasImage(
					this.env.OPENROUTER_API_KEY,
					this.env.OPENROUTER_MODEL,
					imageBase64,
					mimeType,
					command,
				);

				console.log("[voice-pipeline] image description:", imageDescription);

				// Combine the original prompt with the image description
				finalPrompt = `${prompt}. The scene is based on the following image: ${imageDescription}`;
				// Trim to 512 chars for video prompts
				if (normalized.mediaType === "video" && finalPrompt.length > 512) {
					finalPrompt = finalPrompt.slice(0, 509) + "...";
				}

				console.log("[voice-pipeline] enhanced prompt:", finalPrompt);
			}

			if (normalized.mediaType === "video") {
				await this.storeGeneration({
					generationId,
					status: "working",
					message: hasImageReference ? "Generating video from canvas image..." : "Generating video...",
					synthesis,
					prompt: finalPrompt,
					mediaType: "video",
					createdAt,
				});
				this.broadcast({
					type: "agent:status",
					generationId,
					status: hasImageReference ? "Generating video from canvas image..." : "Generating video...",
				});
				requestId = await submitVideoGeneration(
					this.env.HIGGSFIELD_API_KEY,
					this.env.HIGGSFIELD_API_SECRET,
					finalPrompt,
					normalized.params ?? {},
					{ webhookUrl },
				);
			} else {
				await this.storeGeneration({
					generationId,
					status: "working",
					message: hasImageReference ? "Generating image based on canvas reference..." : "Generating image...",
					synthesis,
					prompt: finalPrompt,
					mediaType: "image",
					createdAt,
				});
				this.broadcast({
					type: "agent:status",
					generationId,
					status: hasImageReference ? "Generating image based on canvas reference..." : "Generating image...",
				});
				requestId = await submitImageGeneration(
					this.env.HIGGSFIELD_API_KEY,
					this.env.HIGGSFIELD_API_SECRET,
					finalPrompt,
					normalized.params ?? {},
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
				message: `Waiting for ${normalized.mediaType} to generate...`,
				synthesis,
				prompt: finalPrompt,
				requestId,
				mediaType: normalized.mediaType,
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
					status: `Waiting for ${normalized.mediaType} to generate...`,
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

        // Send existing peers with their usernames
        const peerList: { sessionId: string; username: string }[] = [];
        for (const id of this.voiceSessions.keys()) {
            peerList.push({ sessionId: id, username: this.voiceUsernames.get(id) ?? "" });
        }
        serverWebSocket.send(
            JSON.stringify({ type: "voice-peers", peers: peerList.map(p => p.sessionId), peerDetails: peerList }),
        );

        this.voiceSessions.set(sessionId, serverWebSocket);

        serverWebSocket.addEventListener("message", (event) => {
            try {
                const msg = JSON.parse(event.data as string);

                if (msg.type === "voice-join") {
                    if (msg.username) {
                        this.voiceUsernames.set(sessionId, msg.username);
                    }
                    this.broadcastVoice(msg, sessionId);
                    return;
                }

                if (msg.type === "voice-leave") {
                    this.voiceSessions.delete(sessionId);
                    this.voiceUsernames.delete(sessionId);
                    this.broadcastVoice({ type: "voice-leave", sessionId });
                    serverWebSocket.close();
                    return;
                }

                if (msg.type === "voice-mute-status") {
                    this.broadcastVoice(msg, sessionId);
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
            this.voiceUsernames.delete(sessionId);
            this.broadcastVoice({ type: "voice-leave", sessionId });
        });

        serverWebSocket.addEventListener("error", () => {
            this.voiceSessions.delete(sessionId);
            this.voiceUsernames.delete(sessionId);
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

function getMediaAction(actions?: ClaudeAgentAction[]): ClaudeAgentAction | undefined {
	return actions?.find((action) =>
		action.type === "generate_image" || action.type === "generate_video",
	)
}

type NormalizedVoiceResult =
	| { kind: "canvas"; action: ClaudeAgentAction }
	| { kind: "media"; mediaType: "image" | "video"; prompt: string; params?: Record<string, unknown>; referenceImageId?: string }
	| { kind: "analyze"; message?: string };

function normalizeVoiceClassification(
	classification: VoiceCommandClassification,
): NormalizedVoiceResult {
	switch (classification.type) {
		case "sticky":
		case "comment":
		case "connect":
		case "group":
			return { kind: "canvas", action: classification };
		case "generate_image":
			return {
				kind: "media",
				mediaType: "image",
				prompt: classification.prompt ?? "",
				params: {},
			};
		case "generate_video":
			return {
				kind: "media",
				mediaType: "video",
				prompt: classification.prompt ?? "",
				params: {},
			};
		case "image":
		case "video":
			return {
				kind: "media",
				mediaType: classification.type,
				prompt: classification.prompt,
				params: classification.params,
				referenceImageId: classification.referenceImageId ?? undefined,
			};
		case "analyze":
			return { kind: "analyze", message: classification.message };
		default:
			throw new Error(
				`Unsupported voice command action: ${(classification as any).type}`,
			);
	}
}

import { useSync } from "@tldraw/sync";
import {
    ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import {
    Tldraw,
    Editor,
    AssetRecordType,
    DefaultToolbar,
    DefaultToolbarContent,
    createShapeId,
} from "tldraw";
import { getBookmarkPreview } from "../getBookmarkPreview";
import { multiplayerAssetStore } from "../multiplayerAssetStore";
import { VoiceChatManager, VoiceState } from "../voiceChat";
import {
    HistoryToggleButton,
    HistoryPanel,
    type SnapshotMeta,
} from "../components/HistoryPanel";

interface Generation {
    id: string;
    status: "working" | "done" | "error";
    message?: string;
    imageUrl?: string;
    videoUrl?: string;
    synthesis?: string;
}

interface PageBounds {
    x: number;
    y: number;
    w: number;
    h: number;
}

export function Room() {
    const { roomId } = useParams<{ roomId: string }>();
    const [generations, setGenerations] = useState<Map<string, Generation>>(
        () => new Map(),
    );
    const [aiSelectMode, setAiSelectMode] = useState(false);
    const editorRef = useRef<Editor | null>(null);
    const selectionBoundsRef = useRef<PageBounds | null>(null);
    const autoDismissedRef = useRef<Set<string>>(new Set());
    const [historyOpen, setHistoryOpen] = useState(false);
    const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);

    const fetchSnapshots = useCallback(() => {
        if (!roomId) return;
        fetch(`/api/rooms/${roomId}/snapshots`)
            .then((r) => r.json())
            .then((data: any) => setSnapshots(data.snapshots ?? []))
            .catch(() => {});
    }, [roomId]);

    useEffect(() => {
        if (historyOpen) fetchSnapshots();
    }, [historyOpen, fetchSnapshots]);

    const handleDismissGeneration = useCallback(
        (generationId: string) => {
            setGenerations((prev) => {
                const next = new Map(prev);
                next.delete(generationId);
                return next;
            });
            autoDismissedRef.current.delete(generationId);
            if (roomId) {
                fetch(`/api/rooms/${roomId}/agent/dismiss`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ generationId }),
                }).catch(() => {});
            }
        },
        [roomId],
    );

    useEffect(() => {
        for (const [id, gen] of generations) {
            if (
                gen.status === "done" &&
                !autoDismissedRef.current.has(id)
            ) {
                autoDismissedRef.current.add(id);
                setTimeout(() => handleDismissGeneration(id), 10000);
            }
        }
    }, [generations, handleDismissGeneration]);

    const placeImageOnCanvas = useCallback((imageUrl: string) => {
        const editor = editorRef.current;
        if (!editor) return;

        const bounds = selectionBoundsRef.current;

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const aspectRatio = img.naturalWidth / img.naturalHeight;

            let x: number, y: number, w: number, h: number;

            if (bounds) {
                h = Math.max(bounds.h, 200);
                w = h * aspectRatio;
                x = bounds.x + bounds.w + 60;
                y = bounds.y + (bounds.h - h) / 2;
            } else {
                h = 500;
                w = h * aspectRatio;
                const viewport = editor.getViewportScreenBounds();
                const center = editor.screenToPage({
                    x: viewport.x + viewport.w / 2,
                    y: viewport.y + viewport.h / 2,
                });
                x = center.x - w / 2;
                y = center.y - h / 2;
            }

            const assetId = AssetRecordType.createId();
            editor.createAssets([
                {
                    id: assetId,
                    typeName: "asset",
                    type: "image",
                    meta: {},
                    props: {
                        name: "ai-generated",
                        src: imageUrl,
                        w: img.naturalWidth,
                        h: img.naturalHeight,
                        mimeType: "image/png",
                        isAnimated: false,
                    },
                },
            ]);
            editor.createShape({
                id: createShapeId(),
                type: "image",
                x,
                y,
                props: { assetId, w, h },
            });
        };
        img.onerror = () => {
            const fallbackSize = bounds ? bounds.h : 500;
            const assetId = AssetRecordType.createId();
            editor.createAssets([
                {
                    id: assetId,
                    typeName: "asset",
                    type: "image",
                    meta: {},
                    props: {
                        name: "ai-generated",
                        src: imageUrl,
                        w: 512,
                        h: 512,
                        mimeType: "image/png",
                        isAnimated: false,
                    },
                },
            ]);

            let x: number, y: number;
            if (bounds) {
                x = bounds.x + bounds.w + 60;
                y = bounds.y;
            } else {
                const viewport = editor.getViewportScreenBounds();
                const center = editor.screenToPage({
                    x: viewport.x + viewport.w / 2,
                    y: viewport.y + viewport.h / 2,
                });
                x = center.x - fallbackSize / 2;
                y = center.y - fallbackSize / 2;
            }

            editor.createShape({
                id: createShapeId(),
                type: "image",
                x,
                y,
                props: { assetId, w: fallbackSize, h: fallbackSize },
            });
        };
        img.src = imageUrl;
    }, []);

    const placeVideoOnCanvas = useCallback((videoUrl: string) => {
        const editor = editorRef.current;
        if (!editor) return;

        const viewport = editor.getViewportScreenBounds();
        const center = editor.screenToPage({
            x: viewport.x + viewport.w / 2,
            y: viewport.y + viewport.h / 2,
        });

        const w = 640;
        const h = 360;
        const assetId = AssetRecordType.createId();
        editor.createAssets([
            {
                id: assetId,
                typeName: "asset",
                type: "video",
                meta: {},
                props: {
                    name: "ai-generated-video",
                    src: videoUrl,
                    w,
                    h,
                    mimeType: "video/mp4",
                    isAnimated: true,
                },
            },
        ]);
        editor.createShape({
            id: createShapeId(),
            type: "video",
            x: center.x - w / 2,
            y: center.y - h / 2,
            props: { assetId, w, h },
        });
    }, []);

    const store = useSync({
        uri: `${window.location.origin}/api/connect/${roomId}`,
        assets: multiplayerAssetStore,
        onCustomMessageReceived: (data: any) => {
            if (data.type === "agent:status" && data.generationId) {
                setGenerations((prev) => {
                    const next = new Map(prev);
                    next.set(data.generationId, {
                        id: data.generationId,
                        status: "working",
                        message: data.status,
                    });
                    return next;
                });
            } else if (data.type === "agent:done" && data.generationId) {
                setGenerations((prev) => {
                    const next = new Map(prev);
                    next.set(data.generationId, {
                        id: data.generationId,
                        status: "done",
                        imageUrl: data.imageUrl,
                        videoUrl: data.videoUrl,
                        synthesis: data.synthesis,
                    });
                    return next;
                });
                if (!data.replayed) {
                    if (data.videoUrl) placeVideoOnCanvas(data.videoUrl);
                    else if (data.imageUrl)
                        placeImageOnCanvas(data.imageUrl);
                }
            } else if (data.type === "agent:error" && data.generationId) {
                setGenerations((prev) => {
                    const next = new Map(prev);
                    next.set(data.generationId, {
                        id: data.generationId,
                        status: "error",
                        message: data.message,
                    });
                    return next;
                });
            } else if (
                data.type === "agent:dismiss" &&
                data.generationId
            ) {
                setGenerations((prev) => {
                    const next = new Map(prev);
                    next.delete(data.generationId);
                    return next;
                });
            } else if (data.type === "history:snapshot-created") {
                setSnapshots((prev) => [data.snapshot, ...prev]);
            } else if (data.type === "history:restored") {
                fetchSnapshots();
            }
        },
    });

    const svgToPngBase64 = useCallback(async (svg: string) => {
        return new Promise<string | undefined>((resolve) => {
            try {
                const svgBlob = new Blob([svg], { type: "image/svg+xml" });
                const url = URL.createObjectURL(svgBlob);
                const image = new Image();
                image.crossOrigin = "anonymous";
                image.onload = () => {
                    try {
                        const canvas = document.createElement("canvas");
                        canvas.width = image.width || 1024;
                        canvas.height = image.height || 1024;
                        const ctx = canvas.getContext("2d");
                        if (!ctx) {
                            resolve(undefined);
                            return;
                        }
                        ctx.drawImage(image, 0, 0);
                        const dataUrl = canvas.toDataURL("image/png");
                        resolve(dataUrl.replace(/^data:image\/png;base64,/, ""));
                    } catch (err) {
                        console.warn("[AI] failed to rasterize svg", err);
                        resolve(undefined);
                    } finally {
                        URL.revokeObjectURL(url);
                    }
                };
                image.onerror = () => {
                    URL.revokeObjectURL(url);
                    resolve(undefined);
                };
                image.src = url;
            } catch (err) {
                console.warn("[AI] failed to convert svg", err);
                resolve(undefined);
            }
        });
    }, []);

    const handleAiSelect = useCallback(
        (pageBounds: PageBounds) => {
            setAiSelectMode(false);
            selectionBoundsRef.current = pageBounds;

            const editor = editorRef.current;
            if (!editor || !roomId) return;

            const allShapes = editor.getCurrentPageShapes();
            const shapesInBounds = allShapes.filter((shape) => {
                const b = editor.getShapePageBounds(shape.id);
                if (!b) return false;
                return (
                    pageBounds.x < b.x + b.w &&
                    pageBounds.x + pageBounds.w > b.x &&
                    pageBounds.y < b.y + b.h &&
                    pageBounds.y + pageBounds.h > b.y
                );
            });

            const relevantBindings: any[] = [];
            const seenBindingIds = new Set<string>();
            for (const shape of shapesInBounds) {
                for (const binding of editor.getBindingsInvolvingShape(shape)) {
                    if (!seenBindingIds.has(binding.id)) {
                        seenBindingIds.add(binding.id);
                        relevantBindings.push(binding);
                    }
                }
            }

            (async () => {
                let imagePayload: string | undefined;
                let mimeType: string | undefined;

                const hasDrawings = shapesInBounds.some(
                    (shape) => shape.type === "draw",
                );

                if (hasDrawings) {
                    try {
                        const ids = shapesInBounds.map((shape) => shape.id);
                        const svgExport = await editor.getSvgString(ids, {
                            background: true,
                            padding: 48,
                            darkMode: true,
                        });
                        if (svgExport?.svg) {
                            const png = await svgToPngBase64(svgExport.svg);
                            if (png) {
                                imagePayload = png;
                                mimeType = "image/png";
                            }
                        }
                    } catch (err) {
                        console.warn("[AI] failed to capture sketch preview", err);
                    }
                }

                const payload: Record<string, unknown> = {
                    shapes: shapesInBounds,
                    bindings: relevantBindings,
                };
                if (imagePayload && mimeType) {
                    payload.image = imagePayload;
                    payload.mimeType = mimeType;
                }

                fetch(`/api/rooms/${roomId}/agent/invoke`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                }).catch(() => {});
            })();
        },
        [roomId, svgToPngBase64],
    );

    const handleAiSelectStart = useCallback(() => {
        setAiSelectMode(true);
    }, []);

    const handleAiSelectCancel = useCallback(() => {
        setAiSelectMode(false);
    }, []);

    const components = useMemo(
        () => ({
            MainMenu: null,
            PageMenu: null,
            ActionsMenu: null,
            Toolbar: function GenerateToolbar() {
                return (
                    <DefaultToolbar>
                        <AiGenerateButton
                            aiSelectMode={aiSelectMode}
                            onStart={handleAiSelectStart}
                            onCancel={handleAiSelectCancel}
                        />
                        <DefaultToolbarContent />
                    </DefaultToolbar>
                );
            },
        }),
        [aiSelectMode, handleAiSelectCancel, handleAiSelectStart],
    );

    return (
        <RoomWrapper
            roomId={roomId}
            generations={generations}
            onDismissGeneration={handleDismissGeneration}
            aiSelectMode={aiSelectMode}
            onAiSelectCancel={handleAiSelectCancel}
            onAiSelect={handleAiSelect}
            editor={editorRef.current}
            historyOpen={historyOpen}
            onHistoryToggle={() => setHistoryOpen((v) => !v)}
            onHistoryClose={() => setHistoryOpen(false)}
            snapshots={snapshots}
            onHistoryRefresh={fetchSnapshots}
        >
            <Tldraw
                licenseKey="tldraw-2026-07-13/WyJGSFVscnJvLSIsWyIqIl0sMTYsIjIwMjYtMDctMTMiXQ.ffAi96kEDbYvfzuY4Xc/RMVMdarp1OrXCVWE4vls8eJkZb+PdYIDEWffxFYCYEhoeCKSCn0nM2RsbS/q5DwFzg"
                store={store}
                options={{ deepLinks: true }}
                components={components}
                onMount={(editor) => {
                    editorRef.current = editor;
                    const prefs = editor.user.getUserPreferences();
                    if (!prefs.colorScheme || prefs.colorScheme === "light") {
                        editor.user.updateUserPreferences({
                            colorScheme: "dark",
                        });
                    }
                    editor.registerExternalAssetHandler(
                        "url",
                        getBookmarkPreview,
                    );
                }}
            ></Tldraw>
        </RoomWrapper>
    );
}

function RoomWrapper({
    children,
    roomId,
    generations,
    onDismissGeneration,
    aiSelectMode,
    onAiSelectCancel,
    onAiSelect,
    editor,
    historyOpen,
    onHistoryToggle,
    onHistoryClose,
    snapshots,
    onHistoryRefresh,
}: {
    children: ReactNode;
    roomId?: string;
    generations: Map<string, Generation>;
    onDismissGeneration: (id: string) => void;
    aiSelectMode: boolean;
    onAiSelectCancel: () => void;
    onAiSelect: (bounds: PageBounds) => void;
    editor: Editor | null;
    historyOpen: boolean;
    onHistoryToggle: () => void;
    onHistoryClose: () => void;
    snapshots: SnapshotMeta[];
    onHistoryRefresh: () => void;
}) {
    const navigate = useNavigate();
    const [toastVisible, setToastVisible] = useState(false);

    useEffect(() => {
        if (!toastVisible) return;
        const timeout = setTimeout(() => setToastVisible(false), 2200);
        return () => clearTimeout(timeout);
    }, [toastVisible]);

    const handleCopyRoomId = () => {
        if (roomId) {
            navigator.clipboard.writeText(roomId);
            setToastVisible(true);
        }
    };

    return (
        <div className="room-shell">
            {/* Back button */}
            <button
                className="room-back-button"
                onClick={() => navigate("/")}
                aria-label="Back to home"
            >
                <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="M19 12H5" />
                    <polyline points="12 19 5 12 12 5" />
                </svg>
            </button>

            {/* Floating room ID chip */}
            <button
                className="room-id-chip"
                onClick={handleCopyRoomId}
                aria-label="Copy room ID"
            >
                <span className="room-id-text">{roomId}</span>
                <svg
                    className="room-id-icon"
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
            </button>

            {/* Toast */}
            <div
                className={`room-toast ${toastVisible ? "room-toast--visible" : ""}`}
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <polyline points="20 6 9 17 4 12" />
                </svg>
                Copied to clipboard
            </div>

            {/* Voice chat controls */}
            {roomId && <VoiceChatPanel roomId={roomId} />}

            {/* History toggle + panel */}
            <HistoryToggleButton onClick={onHistoryToggle} />
            {roomId && (
                <HistoryPanel
                    open={historyOpen}
                    onClose={onHistoryClose}
                    roomId={roomId}
                    snapshots={snapshots}
                    onRefresh={onHistoryRefresh}
                />
            )}

            {/* AI area selection overlay */}
            {aiSelectMode && editor && (
                <AiSelectOverlay
                    editor={editor}
                    onCancel={onAiSelectCancel}
                    onSelect={onAiSelect}
                />
            )}

            {/* Agent status cards */}
            {generations.size > 0 && (
                <div className="agent-status-list">
                    {Array.from(generations.values()).map((gen) => (
                        <div key={gen.id} className="agent-status-card">
                            {gen.status === "working" && (
                                <div className="agent-status-working">
                                    <span className="agent-status-dot" />
                                    {gen.message}
                                </div>
                            )}
                            {gen.status === "done" && (
                                <div className="agent-status-done">
                                    <p className="agent-synthesis">
                                        {gen.synthesis}
                                    </p>
                                    <span className="agent-done-label">
                                        {gen.videoUrl
                                            ? "Video placed on canvas"
                                            : "Image placed on canvas"}
                                    </span>
                                    <button
                                        onClick={() =>
                                            onDismissGeneration(gen.id)
                                        }
                                        className="agent-dismiss-btn"
                                    >
                                        dismiss
                                    </button>
                                </div>
                            )}
                            {gen.status === "error" && (
                                <div className="agent-status-error">
                                    <p className="agent-error-msg">
                                        {gen.message}
                                    </p>
                                    <button
                                        onClick={() =>
                                            onDismissGeneration(gen.id)
                                        }
                                        className="agent-dismiss-btn"
                                    >
                                        dismiss
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Full-bleed canvas */}
            <div className="room-canvas">{children}</div>
        </div>
    );
}

// ── AI Select Overlay ──

function AiSelectOverlay({
    editor,
    onCancel,
    onSelect,
}: {
    editor: Editor;
    onCancel: () => void;
    onSelect: (bounds: PageBounds) => void;
}) {
    const [dragging, setDragging] = useState(false);
    const [origin, setOrigin] = useState({ x: 0, y: 0 });
    const [current, setCurrent] = useState({ x: 0, y: 0 });

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [onCancel]);

    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        setOrigin({ x: e.clientX, y: e.clientY });
        setCurrent({ x: e.clientX, y: e.clientY });
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!dragging) return;
        setCurrent({ x: e.clientX, y: e.clientY });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (!dragging) return;
        setDragging(false);

        const minX = Math.min(origin.x, e.clientX);
        const minY = Math.min(origin.y, e.clientY);
        const maxX = Math.max(origin.x, e.clientX);
        const maxY = Math.max(origin.y, e.clientY);

        if (maxX - minX < 24 || maxY - minY < 24) return;

        const topLeft = editor.screenToPage({ x: minX, y: minY });
        const bottomRight = editor.screenToPage({ x: maxX, y: maxY });

        onSelect({
            x: topLeft.x,
            y: topLeft.y,
            w: bottomRight.x - topLeft.x,
            h: bottomRight.y - topLeft.y,
        });
    };

    const rect = dragging
        ? {
              left: Math.min(origin.x, current.x),
              top: Math.min(origin.y, current.y),
              width: Math.abs(current.x - origin.x),
              height: Math.abs(current.y - origin.y),
          }
        : null;

    return (
        <div
            className="ai-select-overlay"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
        >
            <div className="ai-select-hint">
                <WandIcon />
                <span>Drag to select an area</span>
                <kbd>ESC</kbd>
            </div>
            {rect && (
                <div className="ai-select-rect" style={rect}>
                    <div className="ai-select-rect-border" />
                </div>
            )}
        </div>
    );
}

// ── Voice Chat UI ──

function VoiceChatPanel({ roomId }: { roomId: string }) {
    const managerRef = useRef<VoiceChatManager | null>(null);
    const [vs, setVs] = useState<VoiceState>({
        joined: false,
        muted: false,
        peerCount: 0,
        listening: false,
        lastTranscript: "",
    });
    const [commandToast, setCommandToast] = useState<string | null>(null);

    const handleCommand = useCallback(
        (command: string) => {
            console.log("[voice-command]", command);
            setCommandToast(command);
            setTimeout(() => setCommandToast(null), 4000);

            fetch(`/api/rooms/${roomId}/agent/voice-command`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ command }),
            }).catch((err) => {
                console.error("[voice-command] failed to send:", err);
            });
        },
        [roomId],
    );

    useEffect(() => {
        const mgr = new VoiceChatManager(roomId, {
            triggerWord: "hello",
            onCommand: handleCommand,
        });
        managerRef.current = mgr;
        const unsub = mgr.subscribe(setVs);
        return () => {
            unsub();
            mgr.destroy();
        };
    }, [roomId, handleCommand]);

    const handleJoin = async () => {
        try {
            await managerRef.current?.join();
        } catch {
            /* mic denied — state stays unjoined */
        }
    };

    if (!vs.joined) {
        return (
            <button
                className="voice-join-btn"
                onClick={handleJoin}
                aria-label="Join voice chat"
            >
                <MicOffIcon />
                <span>Voice</span>
            </button>
        );
    }

    return (
        <>
            <div className="voice-panel">
                <button
                    className={`voice-btn ${vs.muted ? "voice-btn--muted" : "voice-btn--live"}`}
                    onClick={() => managerRef.current?.toggleMute()}
                    aria-label={vs.muted ? "Unmute" : "Mute"}
                >
                    {vs.muted ? <MicOffIcon /> : <MicOnIcon />}
                </button>

                {vs.peerCount > 0 && (
                    <span className="voice-peers">{vs.peerCount + 1}</span>
                )}

                {vs.listening && <span className="voice-listening-dot" />}

                <button
                    className="voice-btn voice-btn--leave"
                    onClick={() => managerRef.current?.leave()}
                    aria-label="Leave voice chat"
                >
                    <PhoneOffIcon />
                </button>
            </div>

            {commandToast && (
                <div className="voice-command-toast">
                    <span className="voice-command-label">Voice</span>
                    {commandToast}
                </div>
            )}
        </>
    );
}

function AiGenerateButton({
    aiSelectMode,
    onStart,
    onCancel,
}: {
    aiSelectMode: boolean;
    onStart: () => void;
    onCancel: () => void;
}) {
    const btnRef = useRef<HTMLButtonElement>(null);
    const [hover, setHover] = useState(false);
    const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);

    useEffect(() => {
        if (!hover || !btnRef.current) {
            setTipPos(null);
            return;
        }
        const rect = btnRef.current.getBoundingClientRect();
        setTipPos({ x: rect.left + rect.width / 2, y: rect.top });
    }, [hover]);

    const tooltipText = aiSelectMode ? "Cancel" : "Select to generate";

    return (
        <>
            <button
                ref={btnRef}
                className={`ai-generate-btn ${aiSelectMode ? "ai-generate-btn--cancel" : ""}`}
                onClick={aiSelectMode ? onCancel : onStart}
                onMouseEnter={() => setHover(true)}
                onMouseLeave={() => setHover(false)}
                aria-label={tooltipText}
            >
                {aiSelectMode ? <CloseIcon /> : <WandIcon />}
            </button>
            {hover && tipPos && createPortal(
                <span
                    className="ai-generate-tooltip ai-generate-tooltip--visible"
                    style={{ left: tipPos.x, top: tipPos.y }}
                >
                    {tooltipText}
                </span>,
                document.body,
            )}
        </>
    );
}

function WandIcon() {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z" />
            <path d="m14 7 3 3" />
            <path d="M5 6v4" />
            <path d="M19 14v4" />
            <path d="M10 2v2" />
            <path d="M7 8H3" />
            <path d="M21 16h-4" />
            <path d="M11 3H9" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}

function MicOnIcon() {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
    );
}

function MicOffIcon() {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="2" x2="22" y1="2" y2="22" />
            <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
            <path d="M5 10v2a7 7 0 0 0 12 5.29" />
            <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
            <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
    );
}

function PhoneOffIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
            <line x1="22" x2="2" y1="2" y2="22" />
        </svg>
    );
}

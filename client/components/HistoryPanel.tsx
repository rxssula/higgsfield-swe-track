import { useCallback, useEffect, useState } from "react";
import { Tldraw, Editor } from "tldraw";

export interface SnapshotMeta {
    id: string;
    label: string;
    trigger: string;
    created_at: number;
    shape_count: number;
}

// ── Toggle Button ──

export function HistoryToggleButton({ onClick }: { onClick: () => void }) {
    return (
        <button
            className="history-toggle-btn"
            onClick={onClick}
            aria-label="Toggle history"
        >
            <HistoryIcon />
            <span>History</span>
        </button>
    );
}

// ── History Panel ──

export function HistoryPanel({
    open,
    onClose,
    roomId,
    snapshots,
    onRefresh,
}: {
    open: boolean;
    onClose: () => void;
    roomId: string;
    snapshots: SnapshotMeta[];
    onRefresh: () => void;
}) {
    const [saving, setSaving] = useState(false);
    const [previewSnapshot, setPreviewSnapshot] = useState<{
        meta: SnapshotMeta;
        data: any;
    } | null>(null);

    const handleSaveCheckpoint = async () => {
        setSaving(true);
        try {
            await fetch(`/api/rooms/${roomId}/snapshots/create`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ label: "Manual checkpoint" }),
            });
        } catch (e) {
            console.error("[history] save checkpoint error:", e);
        }
        setSaving(false);
    };

    const handleCardClick = async (meta: SnapshotMeta) => {
        try {
            const res = await fetch(
                `/api/rooms/${roomId}/snapshots/${meta.id}`,
            );
            const json = await res.json() as { snapshot: any };
            const snapshot = json.snapshot;
            setPreviewSnapshot({ meta, data: snapshot });
        } catch (e) {
            console.error("[history] load snapshot error:", e);
        }
    };

    const handleRestore = async (mode: "fork" | "hard") => {
        if (!previewSnapshot) return;
        try {
            await fetch(
                `/api/rooms/${roomId}/snapshots/${previewSnapshot.meta.id}/restore`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mode }),
                },
            );
            setPreviewSnapshot(null);
            onRefresh();
        } catch (e) {
            console.error("[history] restore error:", e);
        }
    };

    return (
        <>
            <div className={`history-panel ${open ? "history-panel--open" : ""}`}>
                <div className="history-panel-header">
                    <h3 className="history-panel-title">History</h3>
                    <div className="history-panel-actions">
                        <button
                            className="history-save-btn"
                            onClick={handleSaveCheckpoint}
                            disabled={saving}
                        >
                            {saving ? (
                                <span className="history-save-spinner" />
                            ) : (
                                <SaveIcon />
                            )}
                            <span>Save Checkpoint</span>
                        </button>
                        <button
                            className="history-close-btn"
                            onClick={onClose}
                            aria-label="Close history"
                        >
                            <CloseIcon />
                        </button>
                    </div>
                </div>

                <div className="history-panel-body">
                    {snapshots.length === 0 ? (
                        <div className="history-empty">
                            <HistoryIcon />
                            <p>No snapshots yet</p>
                            <p className="history-empty-hint">
                                Save a checkpoint or let the AI agent create one
                                automatically.
                            </p>
                        </div>
                    ) : (
                        snapshots.map((snap) => (
                            <SnapshotCard
                                key={snap.id}
                                snapshot={snap}
                                onClick={() => handleCardClick(snap)}
                            />
                        ))
                    )}
                </div>
            </div>

            {previewSnapshot && (
                <PreviewOverlay
                    meta={previewSnapshot.meta}
                    data={previewSnapshot.data}
                    onClose={() => setPreviewSnapshot(null)}
                    onRestore={handleRestore}
                />
            )}
        </>
    );
}

// ── Snapshot Card ──

function SnapshotCard({
    snapshot,
    onClick,
}: {
    snapshot: SnapshotMeta;
    onClick: () => void;
}) {
    const triggerLabel =
        snapshot.trigger === "agent"
            ? "AI"
            : snapshot.trigger === "auto"
              ? "Auto"
              : "Manual";
    const triggerClass =
        snapshot.trigger === "agent"
            ? "snapshot-badge--ai"
            : snapshot.trigger === "auto"
              ? "snapshot-badge--auto"
              : "snapshot-badge--manual";

    return (
        <button className="snapshot-card" onClick={onClick}>
            <div className="snapshot-card-top">
                <span className={`snapshot-badge ${triggerClass}`}>
                    {triggerLabel}
                </span>
                <span className="snapshot-time">
                    {formatRelativeTime(snapshot.created_at)}
                </span>
            </div>
            <p className="snapshot-label">{snapshot.label}</p>
            <span className="snapshot-shapes">
                {snapshot.shape_count} element{snapshot.shape_count !== 1 ? "s" : ""}
            </span>
        </button>
    );
}

// ── Preview Overlay ──

function PreviewOverlay({
    meta,
    data,
    onClose,
    onRestore,
}: {
    meta: SnapshotMeta;
    data: any;
    onClose: () => void;
    onRestore: (mode: "fork" | "hard") => void;
}) {
    const [confirmMode, setConfirmMode] = useState<"fork" | "hard" | null>(
        null,
    );

    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                if (confirmMode) setConfirmMode(null);
                else onClose();
            }
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [onClose, confirmMode]);

    const handlePreviewMount = useCallback(
        (editor: Editor) => {
            // Convert RoomSnapshot documents to TLStoreSnapshot format
            const records: Record<string, any> = {};
            for (const doc of data.documents ?? []) {
                if (doc.state && (doc.state as any).id) {
                    records[(doc.state as any).id] = doc.state;
                }
            }
            try {
                editor.loadSnapshot({
                    document: {
                        store: records,
                        schema: data.schema,
                    },
                });
            } catch (e) {
                console.error("[preview] load snapshot error:", e);
            }
            editor.user.updateUserPreferences({ colorScheme: "dark" });
            editor.updateInstanceState({ isReadonly: true });
        },
        [data],
    );

    return (
        <div className="preview-overlay">
            <div className="preview-header">
                <div className="preview-header-info">
                    <span className="preview-label">{meta.label}</span>
                    <span className="preview-time">
                        {formatRelativeTime(meta.created_at)}
                    </span>
                </div>
                <div className="preview-header-actions">
                    <button
                        className="preview-btn preview-btn--fork"
                        onClick={() => setConfirmMode("fork")}
                    >
                        <ForkIcon />
                        Fork from here
                    </button>
                    <button
                        className="preview-btn preview-btn--hard"
                        onClick={() => setConfirmMode("hard")}
                    >
                        <RevertIcon />
                        Hard revert
                    </button>
                    <button
                        className="preview-btn preview-btn--close"
                        onClick={onClose}
                    >
                        <CloseIcon />
                        Close
                    </button>
                </div>
            </div>

            <div className="preview-canvas">
                <Tldraw
                    onMount={handlePreviewMount}
                    components={{
                        MainMenu: null,
                        PageMenu: null,
                        ActionsMenu: null,
                        Toolbar: null,
                        StylePanel: null,
                    }}
                />
                <div className="preview-readonly-badge">Preview (read-only)</div>
            </div>

            {confirmMode && (
                <RestoreConfirmDialog
                    mode={confirmMode}
                    onConfirm={() => {
                        onRestore(confirmMode);
                        setConfirmMode(null);
                    }}
                    onCancel={() => setConfirmMode(null)}
                />
            )}
        </div>
    );
}

// ── Restore Confirmation Dialog ──

function RestoreConfirmDialog({
    mode,
    onConfirm,
    onCancel,
}: {
    mode: "fork" | "hard";
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="restore-dialog-backdrop" onClick={onCancel}>
            <div
                className="restore-dialog"
                onClick={(e) => e.stopPropagation()}
            >
                <h4 className="restore-dialog-title">
                    {mode === "fork" ? "Fork from this snapshot?" : "Hard revert?"}
                </h4>
                <p className="restore-dialog-desc">
                    {mode === "fork"
                        ? "This will save the current state as a checkpoint, then restore the canvas to this snapshot. All collaborators will see the change."
                        : "This will restore the canvas to this snapshot and discard all history after this point. This cannot be undone."}
                </p>
                <div className="restore-dialog-actions">
                    <button
                        className="restore-dialog-btn restore-dialog-btn--cancel"
                        onClick={onCancel}
                    >
                        Cancel
                    </button>
                    <button
                        className={`restore-dialog-btn ${mode === "hard" ? "restore-dialog-btn--danger" : "restore-dialog-btn--confirm"}`}
                        onClick={onConfirm}
                    >
                        {mode === "fork" ? "Fork" : "Revert"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Helpers ──

function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// ── Icons ──

function HistoryIcon() {
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
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l4 2" />
        </svg>
    );
}

function SaveIcon() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
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

function ForkIcon() {
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
            <circle cx="12" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
            <path d="M12 12v3" />
        </svg>
    );
}

function RevertIcon() {
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
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
        </svg>
    );
}

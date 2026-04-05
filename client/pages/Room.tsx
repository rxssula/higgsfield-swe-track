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
import jsPDF from "jspdf";
import { getBookmarkPreview } from "../getBookmarkPreview";
import { multiplayerAssetStore } from "../multiplayerAssetStore";
import { VoiceChatManager, VoiceState, PeerInfo } from "../voiceChat";
import {
	HistoryToggleButton,
	HistoryPanel,
	type SnapshotMeta,
} from "../components/HistoryPanel";
import { CompactStylePanel } from "../components/CompactStylePanel";

// Recursively walks a ProseMirror JSON node — mirrors src/canvas/serializer.ts
function extractRichText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const n = node as Record<string, unknown>;
	if (typeof n.text === "string") return n.text;
	if (Array.isArray(n.content))
		return (n.content as unknown[]).map(extractRichText).join("");
	return "";
}

function extractShapeText(shape: {
	type: string;
	props: unknown;
	meta: unknown;
}): string {
	const props = shape.props as Record<string, unknown>;
	const meta = shape.meta as Record<string, unknown>;

	// AI-generated media: use stored prompt from meta
	if (meta?.aiPrompt && typeof meta.aiPrompt === "string") {
		return `[AI-generated ${shape.type}: ${meta.aiPrompt}]`;
	}

	// Rich text (tldraw v4 ProseMirror format)
	if (props.richText) {
		const rt = extractRichText(props.richText).trim();
		if (rt) return rt;
	}

	// Plain string text
	if (typeof props.text === "string" && props.text.trim()) {
		return props.text.trim();
	}

	// Name fallback (frames, geo shapes)
	if (typeof props.name === "string" && props.name.trim()) {
		return props.name.trim();
	}

	return `[${shape.type}]`;
}

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

const USERNAME_KEY = "vibers-username";

function UsernameModal({ onSubmit }: { onSubmit: (name: string) => void }) {
	const [name, setName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = name.trim();
		if (trimmed) onSubmit(trimmed);
	};

	return (
		<div className="username-modal-overlay">
			<form className="username-modal" onSubmit={handleSubmit}>
				<h2 className="username-modal-title">What's your name?</h2>
				<p className="username-modal-desc">This will be shown to others in the room</p>
				<input
					ref={inputRef}
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="Enter your name..."
					className="username-modal-input"
					maxLength={24}
				/>
				<button
					type="submit"
					disabled={!name.trim()}
					className="username-modal-btn"
				>
					Join Room
				</button>
			</form>
		</div>
	);
}

export function Room() {
	const { roomId } = useParams<{ roomId: string }>();
	const [username, setUsername] = useState<string | null>(() => {
		return localStorage.getItem(USERNAME_KEY);
	});

	const handleSetUsername = useCallback((name: string) => {
		localStorage.setItem(USERNAME_KEY, name);
		setUsername(name);
	}, []);

	if (!username) {
		return <UsernameModal onSubmit={handleSetUsername} />;
	}

	return <RoomInner roomId={roomId} username={username} />;
}

function RoomInner({ roomId, username }: { roomId?: string; username: string }) {
	const [generations, setGenerations] = useState<Map<string, Generation>>(
		() => new Map(),
	);
	const [aiSelectMode, setAiSelectMode] = useState(false);
	const [reorganizeMode, setReorganizeMode] = useState(false);
	const [reorganizing, setReorganizing] = useState(false);
	const [reorganizeToast, setReorganizeToast] = useState(false);
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
			if (gen.status === "done" && !autoDismissedRef.current.has(id)) {
				autoDismissedRef.current.add(id);
				setTimeout(() => handleDismissGeneration(id), 10000);
			}
		}
	}, [generations, handleDismissGeneration]);

	const placeImageOnCanvas = useCallback(
		(imageUrl: string, prompt?: string) => {
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
					meta: prompt ? { aiPrompt: prompt } : {},
					props: { assetId, w, h },
					meta: { aiGenerated: true },
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
					meta: prompt ? { aiPrompt: prompt } : {},
					props: { assetId, w: fallbackSize, h: fallbackSize },
					meta: { aiGenerated: true },
				});
			};
			img.src = imageUrl;
		},
		[],
	);

	const placeVideoOnCanvas = useCallback(
		(videoUrl: string, prompt?: string) => {
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
			const videoShapeId = createShapeId();
			editor.createShape({
				id: videoShapeId,
				type: "video",
				x: center.x - w / 2,
				y: center.y - h / 2,
				meta: prompt ? { aiPrompt: prompt } : {},
				props: { assetId, w, h },
				meta: { aiGenerated: true },
			});
		},
		[],
	);

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
					const mediaPrompt = data.prompt || data.synthesis;
					if (data.videoUrl) placeVideoOnCanvas(data.videoUrl, mediaPrompt);
					else if (data.imageUrl)
						placeImageOnCanvas(data.imageUrl, mediaPrompt);
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
			} else if (data.type === "agent:dismiss" && data.generationId) {
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

	const handleReorganizeStart = useCallback(() => {
		setReorganizeMode(true);
	}, []);

	const handleReorganizeCancel = useCallback(() => {
		setReorganizeMode(false);
	}, []);

	const handleReorganize = useCallback(
		async (pageBounds: PageBounds) => {
			setReorganizeMode(false);
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

			if (shapesInBounds.length === 0) return;

			// Build normalized shapes for Claude (coords relative to selection top-left)
			const shapesForClaude = shapesInBounds.map((shape) => {
				const b = editor.getShapePageBounds(shape.id)!;
				const text = extractShapeText(shape);
				return {
					id: shape.id,
					type: shape.type,
					text,
					x: Math.round(b.x - pageBounds.x),
					y: Math.round(b.y - pageBounds.y),
					w: Math.round(b.w),
					h: Math.round(b.h),
				};
			});

			setReorganizing(true);
			try {
				const res = await fetch(`/api/rooms/${roomId}/agent/reorganize`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						shapes: shapesForClaude,
						container: {
							w: Math.round(pageBounds.w),
							h: Math.round(pageBounds.h),
						},
					}),
				});

				if (!res.ok) return;

				const { moves } = (await res.json()) as {
					reasoning: string;
					moves: { id: string; x: number; y: number }[];
				};

				// Build a lookup from shapeId → shape for parent resolution
				const shapeMap = new Map(shapesInBounds.map((s) => [s.id, s]));

				editor.run(() => {
					for (const move of moves) {
						const shape = shapeMap.get(
							move.id as (typeof shapesInBounds)[number]["id"],
						);
						if (!shape) continue;

						// Denormalize: move coords are relative to selection top-left
						let newX = move.x + pageBounds.x;
						let newY = move.y + pageBounds.y;

						// If shape lives inside a frame, convert to frame-relative coords
						if (shape.parentId && !String(shape.parentId).startsWith("page:")) {
							const parentBounds = editor.getShapePageBounds(
								shape.parentId as typeof shape.id,
							);
							if (parentBounds) {
								newX -= parentBounds.x;
								newY -= parentBounds.y;
							}
						}

						editor.updateShape({
							id: shape.id,
							type: shape.type,
							x: newX,
							y: newY,
						});
					}
				});

				setReorganizeToast(true);
				setTimeout(() => setReorganizeToast(false), 2500);
			} finally {
				setReorganizing(false);
			}
		},
		[roomId],
	);

	const components = useMemo(
		() => ({
			MainMenu: null,
			PageMenu: null,
			ActionsMenu: null,
			StylePanel: null,
			Toolbar: function GenerateToolbar() {
				return (
					<DefaultToolbar>
						<AiGenerateButton
							aiSelectMode={aiSelectMode}
							onStart={handleAiSelectStart}
							onCancel={handleAiSelectCancel}
						/>
						<AiReorganizeButton
							reorganizeMode={reorganizeMode}
							onStart={handleReorganizeStart}
							onCancel={handleReorganizeCancel}
						/>
						<ExportPdfButton editor={editorRef.current} />
						<DefaultToolbarContent />
					</DefaultToolbar>
				);
			},
		}),
		[
			aiSelectMode,
			handleAiSelectCancel,
			handleAiSelectStart,
			reorganizeMode,
			handleReorganizeStart,
			handleReorganizeCancel,
		],
	);

	return (
		<RoomWrapper
			roomId={roomId}
			username={username}
			generations={generations}
			onDismissGeneration={handleDismissGeneration}
			aiSelectMode={aiSelectMode}
			onAiSelectCancel={handleAiSelectCancel}
			onAiSelect={handleAiSelect}
			reorganizeMode={reorganizeMode}
			onReorganizeCancel={handleReorganizeCancel}
			onReorganize={handleReorganize}
			reorganizing={reorganizing}
			reorganizeToast={reorganizeToast}
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
					editor.registerExternalAssetHandler("url", getBookmarkPreview);

					const applyAiGlow = () => {
						const container = editor.getContainer();
						if (!container) return;

						container
							.querySelectorAll(".ai-shape-glow")
							.forEach((el) => el.classList.remove("ai-shape-glow"));

						const shapes = editor.getCurrentPageShapes();
						for (const shape of shapes) {
							if (
								shape.meta &&
								(shape.meta as Record<string, unknown>).aiGenerated
							) {
								const el = container.querySelector(
									`[data-shape-id="${shape.id}"]`,
								);
								if (el) {
									el.classList.add("ai-shape-glow");
								}
							}
						}
					};

					let glowRaf: number | undefined;
					const scheduleGlow = () => {
						if (glowRaf) cancelAnimationFrame(glowRaf);
						glowRaf = requestAnimationFrame(applyAiGlow);
					};

					editor.store.listen(scheduleGlow, {
						scope: "document",
					});
					setTimeout(applyAiGlow, 300);
				}}
			></Tldraw>
		</RoomWrapper>
	);
}

function RoomWrapper({
	children,
	roomId,
	username,
	generations,
	onDismissGeneration,
	aiSelectMode,
	onAiSelectCancel,
	onAiSelect,
	reorganizeMode,
	onReorganizeCancel,
	onReorganize,
	reorganizing,
	reorganizeToast,
	editor,
	historyOpen,
	onHistoryToggle,
	onHistoryClose,
	snapshots,
	onHistoryRefresh,
}: {
	children: ReactNode;
	roomId?: string;
	username: string;
	generations: Map<string, Generation>;
	onDismissGeneration: (id: string) => void;
	aiSelectMode: boolean;
	onAiSelectCancel: () => void;
	onAiSelect: (bounds: PageBounds) => void;
	reorganizeMode: boolean;
	onReorganizeCancel: () => void;
	onReorganize: (bounds: PageBounds) => void;
	reorganizing: boolean;
	reorganizeToast: boolean;
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

			{/* Unified controls strip */}
			<div className="room-controls">
				{editor && <CompactStylePanel editor={editor} />}
				<HistoryToggleButton onClick={onHistoryToggle} />
				{roomId && <VoiceChatPanel roomId={roomId} username={username} />}
			</div>
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
					hintText="Drag to select an area"
				/>
			)}

			{/* Reorganize selection overlay */}
			{reorganizeMode && editor && (
				<AiSelectOverlay
					editor={editor}
					onCancel={onReorganizeCancel}
					onSelect={onReorganize}
					hintText="Drag to select area to reorganize"
				/>
			)}

			{/* Reorganize loading indicator */}
			{reorganizing && (
				<div className="agent-status-list">
					<div className="agent-status-card">
						<div className="agent-status-working">
							<span className="agent-status-dot" />
							Reorganizing layout...
						</div>
					</div>
				</div>
			)}

			{/* Reorganize success toast */}
			{reorganizeToast && (
				<div className="reorganize-toast">
					Layout reorganized — Cmd+Z to undo
				</div>
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
									<p className="agent-synthesis">{gen.synthesis}</p>
									<span className="agent-done-label">
										{gen.videoUrl
											? "Video placed on canvas"
											: "Image placed on canvas"}
									</span>
									<button
										onClick={() => onDismissGeneration(gen.id)}
										className="agent-dismiss-btn"
									>
										dismiss
									</button>
								</div>
							)}
							{gen.status === "error" && (
								<div className="agent-status-error">
									<p className="agent-error-msg">{gen.message}</p>
									<button
										onClick={() => onDismissGeneration(gen.id)}
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
	hintText = "Drag to select an area",
}: {
	editor: Editor;
	onCancel: () => void;
	onSelect: (bounds: PageBounds) => void;
	hintText?: string;
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
				<span>{hintText}</span>
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

const AVATAR_COLORS = [
	"#e05252", "#e09b52", "#52c4e0", "#5275e0",
	"#9b52e0", "#e052b0", "#52e08a", "#e0d452",
];

function hashToColor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) | 0;
	}
	return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function ChevronIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}

function SmallMicOnIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="9" y="1" width="6" height="11" rx="3" />
			<path d="M19 10v1a7 7 0 0 1-14 0v-1" />
			<line x1="12" y1="19" x2="12" y2="23" />
		</svg>
	);
}

function SmallMicOffIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="9" y="1" width="6" height="11" rx="3" />
			<path d="M19 10v1a7 7 0 0 1-14 0v-1" />
			<line x1="12" y1="19" x2="12" y2="23" />
			<line x1="1" y1="1" x2="23" y2="23" />
		</svg>
	);
}

function VoiceChatPanel({ roomId, username }: { roomId: string; username: string }) {
	const managerRef = useRef<VoiceChatManager | null>(null);
	const [vs, setVs] = useState<VoiceState>({
		joined: false,
		muted: false,
		peerCount: 0,
		listening: false,
		lastTranscript: "",
		peers: new Map(),
		selfSpeaking: false,
	});
	const [commandToast, setCommandToast] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);

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
			username,
		});
		managerRef.current = mgr;
		const unsub = mgr.subscribe(setVs);
		return () => {
			unsub();
			mgr.destroy();
		};
	}, [roomId, handleCommand]);

	// Click outside to close
	useEffect(() => {
		if (!expanded) return;
		const onClick = (e: MouseEvent) => {
			if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
				setExpanded(false);
			}
		};
		document.addEventListener("mousedown", onClick);
		return () => document.removeEventListener("mousedown", onClick);
	}, [expanded]);

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

	const selfId = managerRef.current?.getSessionId() ?? "";
	const displayName = managerRef.current?.getUsername() ?? username;
	const totalCount = vs.peerCount + 1;

	return (
		<>
			<div className="voice-panel-wrapper" ref={wrapperRef}>
				<div className="voice-panel">
					<button
						className={`voice-btn ${vs.muted ? "voice-btn--muted" : "voice-btn--live"}`}
						onClick={() => managerRef.current?.toggleMute()}
						aria-label={vs.muted ? "Unmute" : "Mute"}
					>
						{vs.muted ? <MicOffIcon /> : <MicOnIcon />}
					</button>

					{vs.peerCount > 0 && (
						<span className="voice-peers">{totalCount}</span>
					)}

					{vs.listening && <span className="voice-listening-dot" />}

					<button
						className={`voice-btn voice-expand-btn ${expanded ? "voice-expand-btn--open" : ""}`}
						onClick={() => setExpanded(!expanded)}
						aria-label={expanded ? "Collapse participants" : "Show participants"}
					>
						<ChevronIcon />
					</button>

					<button
						className="voice-btn voice-btn--leave"
						onClick={() => managerRef.current?.leave()}
						aria-label="Leave voice chat"
					>
						<PhoneOffIcon />
					</button>
				</div>

				{expanded && (
					<div className="voice-participant-list">
						<div className="voice-participant-header">
							In Call — {totalCount}
						</div>

						{/* Self */}
						<div className="voice-participant">
							<div
								className={`voice-participant-avatar ${vs.selfSpeaking ? "voice-participant-avatar--speaking" : ""}`}
								style={{ background: hashToColor(selfId) }}
							>
								{displayName.slice(0, 2).toUpperCase()}
							</div>
							<span className="voice-participant-name">
								{displayName}
								<span className="voice-participant-you"> (You)</span>
							</span>
							<span className="voice-participant-mute">
								{vs.muted ? <SmallMicOffIcon /> : <SmallMicOnIcon />}
							</span>
						</div>

						{/* Peers */}
						{Array.from(vs.peers.values()).map((peer: PeerInfo) => (
							<div className="voice-participant" key={peer.sessionId}>
								<div
									className={`voice-participant-avatar ${peer.speaking ? "voice-participant-avatar--speaking" : ""}`}
									style={{ background: hashToColor(peer.sessionId) }}
								>
									{peer.username.slice(0, 2).toUpperCase()}
								</div>
								<span className="voice-participant-name">
									{peer.username}
								</span>
								<span className={`voice-participant-mute ${peer.muted ? "voice-participant-mute--muted" : ""}`}>
									{peer.muted ? <SmallMicOffIcon /> : <SmallMicOnIcon />}
								</span>
							</div>
						))}
					</div>
				)}
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
			{hover &&
				tipPos &&
				createPortal(
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

function AiReorganizeButton({
	reorganizeMode,
	onStart,
	onCancel,
}: {
	reorganizeMode: boolean;
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

	const tooltipText = reorganizeMode ? "Cancel" : "Reorganize layout";

	return (
		<>
			<button
				ref={btnRef}
				className={`ai-generate-btn ${reorganizeMode ? "ai-generate-btn--cancel" : ""}`}
				onClick={reorganizeMode ? onCancel : onStart}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				aria-label={tooltipText}
			>
				{reorganizeMode ? <CloseIcon /> : <LayoutIcon />}
			</button>
			{hover &&
				tipPos &&
				createPortal(
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

function LayoutIcon() {
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
			<rect x="3" y="3" width="7" height="7" rx="1" />
			<rect x="14" y="3" width="7" height="7" rx="1" />
			<rect x="3" y="14" width="7" height="7" rx="1" />
			<rect x="14" y="14" width="7" height="7" rx="1" />
		</svg>
	);
}

function PdfIcon() {
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
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<polyline points="14 2 14 8 20 8" />
			<line x1="9" y1="15" x2="15" y2="15" />
		</svg>
	);
}

function ExportPdfButton({ editor }: { editor: Editor | null }) {
	const btnRef = useRef<HTMLButtonElement>(null);
	const [hover, setHover] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [tipPos, setTipPos] = useState<{ x: number; y: number } | null>(null);

	useEffect(() => {
		if (!hover || !btnRef.current) {
			setTipPos(null);
			return;
		}
		const rect = btnRef.current.getBoundingClientRect();
		setTipPos({ x: rect.left + rect.width / 2, y: rect.top });
	}, [hover]);

	const handleExport = useCallback(async () => {
		if (!editor || exporting) return;
		setExporting(true);
		try {
			const ids = [...editor.getCurrentPageShapeIds()];
			if (ids.length === 0) return;

			const svg = await editor.getSvgString(ids, {
				background: true,
				padding: 48,
				darkMode: editor.user.getIsDarkMode(),
			});
			if (!svg) return;

			const image = new Image();
			image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.svg)}`;
			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve();
				image.onerror = reject;
			});

			const scale = 2;
			const canvas = document.createElement("canvas");
			canvas.width = svg.width * scale;
			canvas.height = svg.height * scale;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

			const imgData = canvas.toDataURL("image/png");
			const pdf = new jsPDF({
				orientation: svg.width > svg.height ? "landscape" : "portrait",
				unit: "px",
				format: [svg.width, svg.height],
			});
			pdf.addImage(imgData, "PNG", 0, 0, svg.width, svg.height);
			pdf.save("canvas.pdf");
		} finally {
			setExporting(false);
		}
	}, [editor, exporting]);

	const tooltipText = exporting ? "Exporting…" : "Export as PDF";

	return (
		<>
			<button
				ref={btnRef}
				className={`ai-generate-btn ${exporting ? "ai-generate-btn--working" : ""}`}
				onClick={handleExport}
				disabled={exporting}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				aria-label={tooltipText}
			>
				<PdfIcon />
			</button>
			{hover &&
				tipPos &&
				createPortal(
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

import { useSync } from "@tldraw/sync";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Tldraw } from "tldraw";
import { getBookmarkPreview } from "../getBookmarkPreview";
import { multiplayerAssetStore } from "../multiplayerAssetStore";
import { VoiceChatManager, VoiceState } from "../voiceChat";

export function Room() {
	const { roomId } = useParams<{ roomId: string }>();

	const store = useSync({
		uri: `${window.location.origin}/api/connect/${roomId}`,
		assets: multiplayerAssetStore,
	});

	return (
		<RoomWrapper roomId={roomId}>
			<Tldraw
				licenseKey="tldraw-2026-07-13/WyJGSFVscnJvLSIsWyIqIl0sMTYsIjIwMjYtMDctMTMiXQ.ffAi96kEDbYvfzuY4Xc/RMVMdarp1OrXCVWE4vls8eJkZb+PdYIDEWffxFYCYEhoeCKSCn0nM2RsbS/q5DwFzg"
				store={store}
				options={{ deepLinks: true }}
				components={{
					MainMenu: null,
					PageMenu: null,
					ActionsMenu: null,
				}}
				onMount={(editor) => {
					const prefs = editor.user.getUserPreferences();
					if (!prefs.colorScheme || prefs.colorScheme === "light") {
						editor.user.updateUserPreferences({
							colorScheme: "dark",
						});
					}
					editor.registerExternalAssetHandler("url", getBookmarkPreview);
				}}
			></Tldraw>
		</RoomWrapper>
	);
}

function RoomWrapper({
	children,
	roomId,
}: {
	children: ReactNode;
	roomId?: string;
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

			{/* Full-bleed canvas */}
			<div className="room-canvas">{children}</div>
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

	const handleCommand = useCallback((command: string) => {
		console.log("[voice-command]", command);
		setCommandToast(command);
		setTimeout(() => setCommandToast(null), 4000);
		// TODO: forward to /api/rooms/:roomId/agent/invoke
	}, []);

	useEffect(() => {
		const mgr = new VoiceChatManager(roomId, {
			triggerWord: "jose",
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
					<span className="voice-command-label">Jose</span>
					{commandToast}
				</div>
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

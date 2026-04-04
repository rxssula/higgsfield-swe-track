import { useSync } from "@tldraw/sync";
import { ReactNode, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Tldraw } from "tldraw";
import { getBookmarkPreview } from "../getBookmarkPreview";
import { multiplayerAssetStore } from "../multiplayerAssetStore";

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

            {/* Full-bleed canvas */}
            <div className="room-canvas">{children}</div>
        </div>
    );
}

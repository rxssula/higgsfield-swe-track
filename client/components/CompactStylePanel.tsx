import {
    DefaultColorStyle,
    DefaultDashStyle,
    DefaultFillStyle,
    DefaultSizeStyle,
    useValue,
    DefaultColorThemePalette,
    Editor,
} from "tldraw";
import {
    memo,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

const COLORS = [
    "black",
    "grey",
    "light-violet",
    "violet",
    "blue",
    "light-blue",
    "yellow",
    "orange",
    "green",
    "light-green",
    "light-red",
    "red",
] as const;

const SIZES = ["s", "m", "l", "xl"] as const;

const FILLS = ["none", "semi", "solid"] as const;

const DASHES = ["draw", "dashed", "dotted", "solid"] as const;

const darkPalette = DefaultColorThemePalette.darkMode;

function getHex(name: string): string {
    const entry = darkPalette[name as keyof typeof darkPalette];
    if (entry && typeof entry === "object" && "solid" in entry) {
        return entry.solid;
    }
    return "#f2f2f2";
}

const DASH_ICONS: Record<string, React.ReactNode> = {
    draw: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 10c2-4 4-6 6-6s4 2 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    ),
    dashed: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 8h3M7 8h3M12 8h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    ),
    dotted: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="3" cy="8" r="1" fill="currentColor" />
            <circle cx="7" cy="8" r="1" fill="currentColor" />
            <circle cx="11" cy="8" r="1" fill="currentColor" />
        </svg>
    ),
    solid: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    ),
};

const FILL_ICONS: Record<string, React.ReactNode> = {
    none: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1" />
        </svg>
    ),
    semi: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.15" />
        </svg>
    ),
    solid: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1" fill="currentColor" fillOpacity="0.5" />
        </svg>
    ),
};

export const CompactStylePanel = memo(function CompactStylePanel({
    editor,
}: {
    editor: Editor;
}) {
    const [open, setOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const currentColor = useValue(
        "color",
        () => {
            const styles = editor.getSharedStyles();
            const c = styles.get(DefaultColorStyle);
            if (c?.type === "shared") return c.value;
            return editor.getInstanceState().stylesForNextShape[
                DefaultColorStyle.id
            ] as string ?? "black";
        },
        [editor],
    );

    const currentSize = useValue(
        "size",
        () => {
            const styles = editor.getSharedStyles();
            const s = styles.get(DefaultSizeStyle);
            if (s?.type === "shared") return s.value;
            return editor.getInstanceState().stylesForNextShape[
                DefaultSizeStyle.id
            ] as string ?? "m";
        },
        [editor],
    );

    const currentDash = useValue(
        "dash",
        () => {
            const styles = editor.getSharedStyles();
            const d = styles.get(DefaultDashStyle);
            if (d?.type === "shared") return d.value;
            return editor.getInstanceState().stylesForNextShape[
                DefaultDashStyle.id
            ] as string ?? "draw";
        },
        [editor],
    );

    const currentFill = useValue(
        "fill",
        () => {
            const styles = editor.getSharedStyles();
            const f = styles.get(DefaultFillStyle);
            if (f?.type === "shared") return f.value;
            return editor.getInstanceState().stylesForNextShape[
                DefaultFillStyle.id
            ] as string ?? "none";
        },
        [editor],
    );

    const setColor = useCallback(
        (color: (typeof COLORS)[number]) => {
            editor.run(() => {
                editor.setStyleForSelectedShapes(DefaultColorStyle, color);
                editor.setStyleForNextShapes(DefaultColorStyle, color);
            });
        },
        [editor],
    );

    const setSize = useCallback(
        (size: (typeof SIZES)[number]) => {
            editor.run(() => {
                editor.setStyleForSelectedShapes(DefaultSizeStyle, size);
                editor.setStyleForNextShapes(DefaultSizeStyle, size);
            });
        },
        [editor],
    );

    const setDash = useCallback(
        (dash: (typeof DASHES)[number]) => {
            editor.run(() => {
                editor.setStyleForSelectedShapes(DefaultDashStyle, dash);
                editor.setStyleForNextShapes(DefaultDashStyle, dash);
            });
        },
        [editor],
    );

    const setFill = useCallback(
        (fill: (typeof FILLS)[number]) => {
            editor.run(() => {
                editor.setStyleForSelectedShapes(DefaultFillStyle, fill);
                editor.setStyleForNextShapes(DefaultFillStyle, fill);
            });
        },
        [editor],
    );

    useEffect(() => {
        if (!open) return;
        const handleClickOutside = (e: PointerEvent) => {
            if (
                panelRef.current &&
                !panelRef.current.contains(e.target as Node) &&
                triggerRef.current &&
                !triggerRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        window.addEventListener("pointerdown", handleClickOutside);
        return () =>
            window.removeEventListener("pointerdown", handleClickOutside);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", handleEsc);
        return () => window.removeEventListener("keydown", handleEsc);
    }, [open]);

    const hex = getHex(currentColor);

    return (
        <div className="csp-root">
            <button
                ref={triggerRef}
                className={`csp-trigger ${open ? "csp-trigger--open" : ""}`}
                onClick={() => setOpen((v) => !v)}
                aria-label="Style picker"
            >
                <span
                    className="csp-trigger-dot"
                    style={{ backgroundColor: hex }}
                />
                <svg
                    className={`csp-trigger-chevron ${open ? "csp-trigger-chevron--open" : ""}`}
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="none"
                >
                    <path
                        d="M2 3l2 2 2-2"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </button>

            {open && (
                <div ref={panelRef} className="csp-panel">
                    {/* Color grid */}
                    <div className="csp-section">
                        <div className="csp-color-grid">
                            {COLORS.map((c) => (
                                <button
                                    key={c}
                                    className={`csp-color-dot ${currentColor === c ? "csp-color-dot--active" : ""}`}
                                    style={{ "--dot-color": getHex(c) } as React.CSSProperties}
                                    onClick={() => setColor(c)}
                                    aria-label={c}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Size row */}
                    <div className="csp-section">
                        <span className="csp-label">Size</span>
                        <div className="csp-row">
                            {SIZES.map((s) => (
                                <button
                                    key={s}
                                    className={`csp-size-btn ${currentSize === s ? "csp-size-btn--active" : ""}`}
                                    onClick={() => setSize(s)}
                                >
                                    {s.toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Fill row */}
                    <div className="csp-section">
                        <span className="csp-label">Fill</span>
                        <div className="csp-row">
                            {FILLS.map((f) => (
                                <button
                                    key={f}
                                    className={`csp-icon-btn ${currentFill === f ? "csp-icon-btn--active" : ""}`}
                                    onClick={() => setFill(f)}
                                    aria-label={f}
                                >
                                    {FILL_ICONS[f]}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Dash row */}
                    <div className="csp-section">
                        <span className="csp-label">Stroke</span>
                        <div className="csp-row">
                            {DASHES.map((d) => (
                                <button
                                    key={d}
                                    className={`csp-icon-btn ${currentDash === d ? "csp-icon-btn--active" : ""}`}
                                    onClick={() => setDash(d)}
                                    aria-label={d}
                                >
                                    {DASH_ICONS[d]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

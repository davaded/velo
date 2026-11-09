import React, { useRef, useState } from "react";

/**
 * Rare UI (rareui.com) — Interactive Pointer-Tracking Radial Spotlight Card
 * with Specular Top-Edge Highlight & Tactile Keycap Badge
 */
export const RareSpotlightCard: React.FC<{
  onClick?: () => void;
  title: React.ReactNode;
  subtitle: string;
  shortcut?: string;
  badge?: string;
  children?: React.ReactNode;
}> = ({ onClick, title, subtitle, shortcut, badge, children }) => {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    setCoords({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative overflow-hidden p-3.5 rounded-[10px] border text-left transition-all duration-200 cursor-pointer rare-specular-surface group"
      style={{
        backgroundColor: "var(--surface-1)",
        borderColor: hovered ? "var(--border-accent)" : "var(--border-subtle)",
        transform: hovered ? "translateY(-1px)" : "translateY(0px)",
      }}
    >
      {/* Pointer-following radial spotlight glow */}
      <div
        className="pointer-events-none absolute -inset-px transition-opacity duration-300"
        style={{
          opacity: hovered ? 1 : 0,
          background: `radial-gradient(240px circle at ${coords.x}px ${coords.y}px, rgba(124, 203, 160, 0.13), transparent 75%)`,
        }}
      />

      <div className="relative z-10 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12.5px] font-semibold flex items-center gap-2">
            {title}
          </div>
          <div className="flex items-center gap-1.5">
            {badge && (
              <span
                className="font-mono-code text-[10px] px-1.5 py-0.5 rounded-full"
                style={{
                  backgroundColor: "rgba(124, 203, 160, 0.14)",
                  color: "var(--accent-bright)",
                }}
              >
                {badge}
              </span>
            )}
            {shortcut && <kbd className="rare-keycap">{shortcut}</kbd>}
          </div>
        </div>
        <p
          className="text-[11.5px] leading-relaxed"
          style={{ color: "var(--fg-muted)" }}
        >
          {subtitle}
        </p>
        {children}
      </div>
    </button>
  );
};

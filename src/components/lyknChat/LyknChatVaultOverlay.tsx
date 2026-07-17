import React, { useEffect } from "react";

interface LyknChatVaultOverlayProps {
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDeactivate: () => void;
}

const LyknChatVaultOverlay = React.memo(function LyknChatVaultOverlay({
  onDrop,
  onDeactivate,
}: LyknChatVaultOverlayProps) {
  // Escape dismisses the overlay. Without this, dragging a vault item
  // onto the canvas and then changing your mind required either dropping
  // it somewhere (with side-effects) or hunting for the original vault
  // tile to drop it back on — neither was discoverable.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDeactivate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDeactivate]);

  return (
    <div
      className="fixed inset-0 z-[250]"
      style={{ background: "transparent" }}
      role="dialog"
      aria-modal="true"
      aria-label="Drop vault item onto canvas. Press Escape to cancel"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null || !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
          onDeactivate();
        }
      }}
      onDrop={onDrop}
    />
  );
});

export default LyknChatVaultOverlay;

import React from "react";

interface OmniaVaultOverlayProps {
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDeactivate: () => void;
}

const OmniaVaultOverlay = React.memo(function OmniaVaultOverlay({
  onDrop,
  onDeactivate,
}: OmniaVaultOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-[250]"
      style={{ background: "transparent" }}
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

export default OmniaVaultOverlay;

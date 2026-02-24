import React from "react";
import { useNavigate } from "react-router-dom";
import SettingsModal from "@/components/notes/SettingsModal";

export default function Settings() {
  const nav = useNavigate();
  return (
    <div className="min-h-screen bg-[#f2f2f7]/80 text-black">
      <SettingsModal
        isOpen
        onClose={() => nav("/")}
      />
    </div>
  );
}

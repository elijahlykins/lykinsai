import React from "react";
import { useNavigate } from "react-router-dom";
import SettingsModal from "@/components/notes/SettingsModal";

export default function Settings() {
  const nav = useNavigate();
  return (
    <div className="min-h-screen bg-transparent text-black dark:text-white">
      <SettingsModal
        isOpen
        onClose={() => nav("/app")}
      />
    </div>
  );
}

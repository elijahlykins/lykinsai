import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function NotesPage() {
  const navigate = useNavigate();
  const legacyEnabled = String(import.meta.env.VITE_ENABLE_LEGACY_NOTES || "").toLowerCase() === "true";

  useEffect(() => {
    if (!legacyEnabled) {
      navigate("/omnia", { replace: true });
      return;
    }
    navigate(createPageUrl('Create'));
  }, [legacyEnabled, navigate]);

  return (
    <div className="min-h-screen bg-dark flex items-center justify-center">
      <p className="text-white">Redirecting...</p>
    </div>
  );
}
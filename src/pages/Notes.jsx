import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../utils';

export default function NotesPage() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(createPageUrl('Create'));
  }, [navigate]);

  return (
    <div className="min-h-screen bg-dark flex items-center justify-center">
      <p className="text-white">Redirecting...</p>
    </div>
  );
}
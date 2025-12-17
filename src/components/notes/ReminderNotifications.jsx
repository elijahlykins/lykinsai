import React, { useState, useEffect } from 'react';
import { Bell, X } from 'lucide-react';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';

export default function ReminderNotifications({ notes = [] }) {
  const [dismissedReminders, setDismissedReminders] = useState([]);

  // Filter due reminders (not dismissed + reminder date <= now)
  const dueReminders = notes.filter(note => {
    if (!note.reminder || dismissedReminders.includes(note.id)) return false;
    const reminderDate = new Date(note.reminder);
    const now = new Date();
    return reminderDate <= now;
  });

  const handleDismiss = (noteId) => {
    setDismissedReminders(prev => [...prev, noteId]);
  };

  if (dueReminders.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
      <AnimatePresence>
        {dueReminders.map(note => (
          <motion.div
            key={note.id}
            initial={{ opacity: 0, x: 100 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 100 }}
            className="bg-white border-2 border-black rounded-lg shadow-lg p-4 flex items-start gap-3"
          >
            <Bell className="w-5 h-5 text-black flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-black text-sm">{note.title}</p>
              <p className="text-xs text-gray-600 line-clamp-2">{note.content}</p>
              <p className="text-xs text-gray-500 mt-1">
                Due: {format(new Date(note.reminder), 'MMM d, h:mm a')}
              </p>
            </div>
            <button
              onClick={() => handleDismiss(note.id)}
              className="text-gray-400 hover:text-black transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
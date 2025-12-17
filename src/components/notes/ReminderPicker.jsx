import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Bell, X } from 'lucide-react';
import { format } from 'date-fns';

export default function ReminderPicker({ isOpen, onClose, currentReminder, onSet, onRemove }) {
  // Safely parse currentReminder date
  const getValidDate = (dateString) => {
    if (!dateString) return new Date();
    const parsed = new Date(dateString);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  };

  const [date, setDate] = useState(getValidDate(currentReminder));
  const [time, setTime] = useState(
    currentReminder ? (() => {
      const parsed = new Date(currentReminder);
      return isNaN(parsed.getTime()) ? '09:00' : format(parsed, 'HH:mm');
    })() : '09:00'
  );

  const handleSet = () => {
    const [hours, minutes] = time.split(':');
    const reminderDate = new Date(date);
    reminderDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    onSet(reminderDate.toISOString());
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-white border border-gray-200 text-black max-w-md">
        <DialogHeader>
          <DialogTitle className="text-black flex items-center gap-2">
            <Bell className="w-5 h-5" />
            Set Reminder
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div>
            <Label className="text-black mb-2 block">Date</Label>
            <Calendar
              mode="single"
              selected={date}
              onSelect={setDate}
              className="rounded-md border border-gray-200"
            />
          </div>

          <div>
            <Label className="text-black mb-2 block">Time</Label>
            <Input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="bg-gray-50 border-gray-300 text-black"
            />
          </div>
        </div>

        <div className="flex justify-between gap-2 pt-4 border-t border-gray-200">
          {currentReminder && (
            <Button
              onClick={() => {
                onRemove();
                onClose();
              }}
              variant="outline"
              className="text-red-600 border-red-300 hover:bg-red-50"
            >
              <X className="w-4 h-4 mr-2" />
              Remove
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button onClick={onClose} variant="outline" className="border-gray-300 text-black">
              Cancel
            </Button>
            <Button onClick={handleSet} className="bg-black text-white hover:bg-gray-800">
              Set Reminder
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
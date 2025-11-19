import React, { useState } from 'react';
import { Clock, Archive, Search, MessageSquare, Settings } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function NotionSidebar({ activeView, onViewChange, onOpenSearch, onOpenChat, onOpenSettings }) {
  return (
    <div className="h-full bg-sidebar border-r border-white/10 flex flex-col p-3">
      <div className="mb-8 px-3 py-4">
        <h1 className="text-2xl font-bold text-white tracking-tight">lykinsai</h1>
        <p className="text-xs text-gray-500 mt-1">Your AI Memory Companion</p>
      </div>

      <TooltipProvider delayDuration={300}>
        <nav className="space-y-1 flex-1">
          {/* Short Term */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onViewChange('short_term')}
                className={`notion-sidebar-button ${activeView === 'short_term' ? 'active' : ''}`}
              >
                <Clock className="w-4 h-4" />
                <span>Short Term</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Recent memories from the past 30 days</p>
            </TooltipContent>
          </Tooltip>

          {/* Long Term */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onViewChange('long_term')}
                className={`notion-sidebar-button ${activeView === 'long_term' ? 'active' : ''}`}
              >
                <Archive className="w-4 h-4" />
                <span>Long Term</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Archived memories older than 30 days</p>
            </TooltipContent>
          </Tooltip>

          <div className="my-4 border-t border-white/10" />

          {/* Search */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSearch}
                className="notion-sidebar-button"
              >
                <Search className="w-4 h-4" />
                <span>AI Search</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Search memories by ideas and concepts</p>
            </TooltipContent>
          </Tooltip>

          {/* Chat */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenChat}
                className="notion-sidebar-button"
              >
                <MessageSquare className="w-4 h-4" />
                <span>Memory Chat</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Chat with AI about your memories</p>
            </TooltipContent>
          </Tooltip>
        </nav>

        {/* Settings at bottom */}
        <div className="mt-auto pt-3 border-t border-white/10">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSettings}
                className="notion-sidebar-button"
              >
                <Settings className="w-4 h-4" />
                <span>Settings</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Customize your preferences</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}
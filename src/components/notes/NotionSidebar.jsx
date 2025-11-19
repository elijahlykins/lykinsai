import React from 'react';
import { Settings, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function NotionSidebar({ activeView, onViewChange, onOpenSearch, onOpenChat, onOpenSettings, isCollapsed, onToggleCollapse }) {
  if (isCollapsed) {
    return (
      <div className="h-full bg-sidebar border-r border-white/10 flex flex-col p-3 w-16">
        <button
          onClick={onToggleCollapse}
          className="p-2 hover:bg-white/10 rounded-lg transition-all text-black bg-white"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
        <TooltipProvider delayDuration={300}>
          <div className="mt-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onOpenSettings}
                  className="p-2 hover:bg-white/10 rounded-lg transition-all text-black"
                >
                  <Settings className="w-5 h-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Settings</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
    );
  }

  return (
    <div className="h-full bg-sidebar border-r border-white/10 flex flex-col p-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">lykinsai</h1>
          <p className="text-xs text-gray-500 mt-1">Your AI Memory Companion</p>
        </div>
        <button
          onClick={onToggleCollapse}
          className="p-1 hover:bg-white/20 rounded transition-all text-black"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      </div>

      <TooltipProvider delayDuration={300}>
        <nav className="space-y-3 flex-1">
          {/* Short Term */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onViewChange('short_term')}
                className={`w-full px-6 py-3 rounded-full text-sm font-medium transition-all bg-white text-black ${
                  activeView === 'short_term'
                    ? 'ring-2 ring-white/50'
                    : 'hover:ring-2 hover:ring-white/30'
                }`}
              >
                Short Term
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
                className={`w-full px-6 py-3 rounded-full text-sm font-medium transition-all bg-white text-black ${
                  activeView === 'long_term'
                    ? 'ring-2 ring-white/50'
                    : 'hover:ring-2 hover:ring-white/30'
                }`}
              >
                Long Term
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Archived memories older than 30 days</p>
            </TooltipContent>
          </Tooltip>

          {/* Search */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSearch}
                className="w-full px-6 py-3 rounded-full text-sm font-medium bg-white text-black hover:ring-2 hover:ring-white/30 transition-all"
              >
                AI Search
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
                className="w-full px-6 py-3 rounded-full text-sm font-medium bg-white text-black hover:ring-2 hover:ring-white/30 transition-all"
              >
                Memory Chat
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Chat with AI about your memories</p>
            </TooltipContent>
          </Tooltip>
        </nav>

        {/* Settings at bottom */}
        <div className="mt-auto pt-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSettings}
                className="p-2 hover:bg-white/10 rounded-lg transition-all text-black"
              >
                <Settings className="w-5 h-5" />
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
import React from 'react';
import { Settings, ChevronLeft, ChevronRight, Plus, Clock, Archive, Search, MessageCircle, Tags, Bell } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function NotionSidebar({ activeView, onViewChange, onOpenSearch, onOpenChat, onOpenSettings, isCollapsed, onToggleCollapse }) {
  const navItems = [
    { id: 'create', icon: Plus, label: 'Create', tooltip: 'Create new memories' },
    { id: 'short_term', icon: Clock, label: 'Short Term', tooltip: 'Recent memories from the past 30 days' },
    { id: 'long_term', icon: Archive, label: 'Long Term', tooltip: 'Archived memories older than 30 days' },
    { id: 'search', icon: Search, label: 'AI Search', tooltip: 'Search memories by ideas and concepts', onClick: onOpenSearch },
    { id: 'chat', icon: MessageCircle, label: 'Memory Chat', tooltip: 'Chat with AI about your memories', onClick: onOpenChat },
    { id: 'tags', icon: Tags, label: 'Tags', tooltip: 'Manage your tags' },
    { id: 'reminders', icon: Bell, label: 'Reminders', tooltip: 'View and manage reminders' },
  ];

  if (isCollapsed) {
    return (
      <div className="h-full bg-black/40 backdrop-blur-xl border-r border-white/10 flex flex-col p-3 w-20">
        <button
          onClick={onToggleCollapse}
          className="p-2 hover:bg-white/10 rounded-lg transition-all text-white"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
        <TooltipProvider delayDuration={300}>
          <div className="flex-1 flex flex-col items-center gap-3 mt-8">
            {navItems.map((item) => (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => item.onClick ? item.onClick() : onViewChange(item.id)}
                    className={`p-3 rounded-xl transition-all ${
                      activeView === item.id
                        ? 'bg-white/20 text-white shadow-lg'
                        : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <item.icon className="w-5 h-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{item.tooltip}</p>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <div className="mt-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onOpenSettings}
                  className="p-3 hover:bg-white/10 rounded-xl transition-all text-white/70 hover:text-white"
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
    <div className="h-full bg-black/40 backdrop-blur-xl border-r border-white/10 flex flex-col p-4">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">lykinsai</h1>
          <p className="text-xs text-white/60 mt-1">Your AI Memory Companion</p>
        </div>
        <button
          onClick={onToggleCollapse}
          className="p-1 hover:bg-white/10 rounded transition-all text-white"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      </div>

      <TooltipProvider delayDuration={300}>
        <nav className="space-y-2 flex-1">
          {navItems.map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => item.onClick ? item.onClick() : onViewChange(item.id)}
                  className={`w-full px-4 py-3 rounded-xl text-sm font-medium transition-all flex items-center gap-3 ${
                    activeView === item.id
                      ? 'bg-white/20 text-white shadow-lg'
                      : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <item.icon className="w-5 h-5" />
                  {item.label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{item.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </nav>

        {/* Settings at bottom */}
        <div className="mt-auto pt-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSettings}
                className="p-3 hover:bg-white/10 rounded-xl transition-all text-white/70 hover:text-white flex items-center gap-2"
              >
                <Settings className="w-5 h-5" />
                <span className="text-sm">Settings</span>
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
import React from 'react';
import { Settings, ChevronLeft, ChevronRight, Plus, Clock, Archive, Search, MessageCircle, Tags, Bell, Crown, Folder } from 'lucide-react';
// ❌ Removed base44 import and useQuery
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export default function NotionSidebar({ 
  activeView, 
  onViewChange, 
  onOpenSearch, 
  onOpenChat, 
  onOpenSettings, 
  isCollapsed, 
  onToggleCollapse,
  folders = [], // ✅ Receive folders as a prop
  density = 'normal', // 'normal' | 'compact'
  showCollapseToggle = true
}) {
  const isCompact = density === 'compact';
  const navItems = [
    { id: 'create', icon: Plus, label: 'Create', tooltip: 'Create new memories' },
    { id: 'vault', icon: Clock, label: 'Vault', tooltip: 'View all your memories' },
    { id: 'chat', icon: MessageCircle, label: 'Vault Chat', tooltip: 'Chat with AI about your memories', onClick: onOpenChat },
  ];

  const handleBillingClick = () => {
    window.location.href = '/billing';
  };

  if (isCollapsed) {
    return (
      <div className={`h-full glass-control flex flex-col ${isCompact ? 'p-2 w-16' : 'p-3 w-20'}`}>
        {showCollapseToggle && (
          <button
            onClick={onToggleCollapse}
            className={`${isCompact ? 'p-1.5' : 'p-2'} glass-control hover:opacity-90 rounded-xl transition-all text-black dark:text-white`}
          >
            <ChevronRight className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
          </button>
        )}
        <TooltipProvider delayDuration={300}>
          <div className={`flex-1 flex flex-col items-center ${isCompact ? 'gap-2 mt-5' : 'gap-3 mt-8'}`}>
            {navItems.map((item) => (
              <Tooltip key={item.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => item.onClick ? item.onClick() : onViewChange(item.id)}
                    className={`${isCompact ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'} transition-all glass-control text-black dark:text-white hover:opacity-90 ${
                      activeView === item.id ? 'ring-1 ring-white/40 dark:ring-white/20' : ''
                    }`}
                  >
                    <item.icon className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{item.tooltip}</p>
                </TooltipContent>
              </Tooltip>
            ))}
            
            <div className="w-full h-px bg-black/10 dark:bg-white/10 my-2" />
            
            {/* Folders collapsed */}
            {folders.map(folder => (
                <Tooltip key={folder.id}>
                    <TooltipTrigger asChild>
                    <button
                        className={`${isCompact ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'} transition-all glass-control text-black dark:text-white hover:opacity-90`}
                    >
                        <Folder className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
                    </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                    <p>{folder.name}</p>
                    </TooltipContent>
                </Tooltip>
            ))}
          </div>
          <div className={`mt-auto ${isCompact ? 'space-y-1.5' : 'space-y-2'}`}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleBillingClick}
                  className={`${isCompact ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'} glass-control hover:opacity-90 transition-all text-gray-800 dark:text-gray-100`}
                >
                  <Crown className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Upgrade</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onOpenSettings}
                  className={`${isCompact ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'} glass-control hover:opacity-90 transition-all text-gray-800 dark:text-gray-100`}
                >
                  <Settings className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
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
    <div className={`h-full glass-control flex flex-col ${isCompact ? 'p-3' : 'p-4'}`}>
      <div className={`flex items-center justify-between ${isCompact ? 'mb-4' : 'mb-8'}`}>
        <div>
          <h1 className={`${isCompact ? 'text-xl' : 'text-2xl'} font-bold text-black dark:text-white tracking-tight`}>LYKN</h1>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">Your AI Vault Companion</p>
        </div>
        {showCollapseToggle && (
          <button
            onClick={onToggleCollapse}
            className="p-1 glass-control hover:opacity-90 rounded-xl transition-all text-black dark:text-white"
          >
            <ChevronLeft className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
          </button>
        )}
      </div>

      <TooltipProvider delayDuration={300}>
        <nav className="space-y-2 flex-1">
          {navItems.map((item) => (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => item.onClick ? item.onClick() : onViewChange(item.id)}
                  className={`w-full ${isCompact ? 'px-3 py-2 rounded-xl gap-2' : 'px-4 py-3 rounded-2xl gap-3'} text-sm font-medium transition-all flex items-center glass-control text-black dark:text-white hover:opacity-90 ${
                    activeView === item.id ? 'ring-1 ring-white/40 dark:ring-white/20' : ''
                  }`}
                >
                  <item.icon className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
                  {item.label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>{item.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          ))}

          {folders.length > 0 && (
            <div className="pt-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-2">Folders</p>
                <div className="space-y-1">
                    {folders.map(folder => (
                        <button
                            key={folder.id}
                            className={`w-full ${isCompact ? 'px-3 py-1.5 gap-2' : 'px-4 py-2 gap-3'} rounded-xl text-sm font-medium transition-all flex items-center glass-control text-black dark:text-white hover:opacity-90`}
                        >
                            <Folder className={`${isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
                            {folder.name}
                        </button>
                    ))}
                </div>
            </div>
          )}
        </nav>

        <div className="mt-auto pt-3 space-y-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleBillingClick}
                className={`w-full ${isCompact ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'} glass-control hover:opacity-90 transition-all text-black dark:text-white flex items-center gap-2`}
              >
                <Crown className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
                <span className="text-sm">Upgrade</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>View plans and upgrade</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenSettings}
                className={`w-full ${isCompact ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'} glass-control hover:opacity-90 transition-all text-black dark:text-white flex items-center gap-2`}
              >
                <Settings className={`${isCompact ? 'w-4 h-4' : 'w-5 h-5'}`} />
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
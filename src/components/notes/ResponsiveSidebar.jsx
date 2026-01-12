import React, { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import NotionSidebar from './NotionSidebar';

export default function ResponsiveSidebar({
  activeView,
  onViewChange,
  onOpenSearch,
  onOpenChat,
  onOpenSettings,
  isCollapsed,
  onToggleCollapse,
  folders = []
}) {
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu when view changes
  const handleViewChange = (view) => {
    if (onViewChange) {
      onViewChange(view);
    }
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  };

  // Close mobile menu when actions are triggered
  const handleOpenSearch = () => {
    if (onOpenSearch) {
      onOpenSearch();
    }
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  };

  const handleOpenChat = () => {
    if (onOpenChat) {
      onOpenChat();
    }
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  };

  const handleOpenSettings = () => {
    if (onOpenSettings) {
      onOpenSettings();
    }
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  };

  const sidebarProps = {
    activeView,
    onViewChange: handleViewChange,
    onOpenSearch: handleOpenSearch,
    onOpenChat: handleOpenChat,
    onOpenSettings: handleOpenSettings,
    isCollapsed,
    onToggleCollapse,
    folders
  };

  // Mobile: Show as drawer
  if (isMobile) {
    return (
      <>
        {/* Mobile Menu Button */}
        <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="fixed top-4 left-4 z-50 md:hidden bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm border border-gray-200 dark:border-gray-700 shadow-lg touch-manipulation min-w-[44px] min-h-[44px]"
            >
              <Menu className="h-5 w-5" />
              <span className="sr-only">Open menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[280px] sm:w-[320px] p-0 bg-glass-sidebar overflow-y-auto">
            <div className="h-full">
              <NotionSidebar {...sidebarProps} isCollapsed={false} />
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Desktop: Show as regular sidebar
  return (
    <div className={`${isCollapsed ? 'w-16' : 'w-64'} flex-shrink-0 transition-all duration-300 hidden md:block`}>
      <NotionSidebar {...sidebarProps} />
    </div>
  );
}

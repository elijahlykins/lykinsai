import React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { CustomizationProvider } from './components/customization/CustomizationContext';
import GlobalCustomizer from './components/customization/GlobalCustomizer';
import { Toaster } from '@/components/ui/toaster';

export default function Layout() {
  const location = useLocation();

  return (
    <CustomizationProvider>
      <div className="min-h-screen bg-background font-sans antialiased">
        <GlobalCustomizer />
        <Outlet />
        <Toaster />
      </div>
    </CustomizationProvider>
  );
}
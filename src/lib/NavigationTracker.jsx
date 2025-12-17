import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './SupabaseAuth';
import { base44 } from '@/api/base44Client';
import { pagesConfig } from '@/pages.config';

export default function NavigationTracker() {
    const location = useLocation();
    const { user } = useAuth(); // Use SupabaseAuth instead
    const { Pages, mainPage } = pagesConfig;
    const mainPageKey = mainPage ?? Object.keys(Pages)[0];
    const isAuthenticated = !!user; // Convert user to boolean

    // Post navigation changes to parent window
    useEffect(() => {
        window.parent?.postMessage({
            type: "app_changed_url",
            url: window.location.href
        }, '*');
    }, [location]);

    // Log user activity when navigating to a page
    useEffect(() => {
        // Extract page name from pathname
        const pathname = location.pathname;
        let pageName;
        
        if (pathname === '/' || pathname === '') {
            pageName = mainPageKey;
        } else {
            // Remove leading slash and get the first segment
            const pathSegment = pathname.replace(/^\//, '').split('/')[0];
            
            // Try case-insensitive lookup in Pages config
            const pageKeys = Object.keys(Pages);
            const matchedKey = pageKeys.find(
                key => key.toLowerCase() === pathSegment.toLowerCase()
            );
            
            pageName = matchedKey || null;
        }

        if (isAuthenticated && pageName) {
            // Only try to log if base44 is available and has appLogs
            try {
                if (base44?.appLogs?.logUserInApp) {
                    base44.appLogs.logUserInApp(pageName).catch(() => {
                        // Silently fail - logging shouldn't break the app
                    });
                }
            } catch (error) {
                // Silently fail - logging shouldn't break the app
            }
        }
    }, [location, isAuthenticated, Pages, mainPageKey]);

    return null;
}
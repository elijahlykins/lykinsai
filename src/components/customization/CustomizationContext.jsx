import React, { createContext, useContext, useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const CustomizationContext = createContext();

export function useCustomization() {
  return useContext(CustomizationContext);
}

export function CustomizationProvider({ children }) {
  const queryClient = useQueryClient();
  const [activeOverrides, setActiveOverrides] = useState([]);
  
  // Fetch customizations
  const { data: customizationData } = useQuery({
    queryKey: ['appCustomization'],
    queryFn: async () => {
      const user = await base44.auth.me();
      if (!user) return null;
      const list = await base44.entities.AppCustomization.list();
      // Find the one for this user or create default if not exists (logic usually handled in component or backend, here we just pick first or match)
      // Since we can't filter by generic JSON props easily in all DBs, we filter in memory or assume 1 per user
      const myCustomization = list.find(c => c.created_by === user.email) || list[0]; 
      return myCustomization || { aiSettings: { name: 'Lykins AI' }, elementOverrides: [] };
    },
    staleTime: 1000 * 60 * 5
  });

  const saveMutation = useMutation({
    mutationFn: async (newData) => {
      const user = await base44.auth.me();
      const list = await base44.entities.AppCustomization.list();
      const existing = list.find(c => c.created_by === user.email);
      
      if (existing) {
        return base44.entities.AppCustomization.update(existing.id, newData);
      } else {
        return base44.entities.AppCustomization.create({
           ...newData,
           userId: user.id
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['appCustomization']);
    }
  });

  // Apply overrides
  useEffect(() => {
    if (customizationData?.elementOverrides) {
      const styleId = 'user-custom-styles';
      let styleTag = document.getElementById(styleId);
      if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = styleId;
        document.head.appendChild(styleTag);
      }

      // Generate CSS
      let css = '';
      customizationData.elementOverrides.forEach(override => {
        if (override.styles && Object.keys(override.styles).length > 0) {
           // Convert camelCase to kebab-case
           const styleProps = Object.entries(override.styles).map(([key, val]) => {
             const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
             return `${cssKey}: ${val} !important;`;
           }).join(' ');
           
           // Use a data attribute selector if possible or raw selector
           css += `${override.selector} { ${styleProps} }\n`;
        }
        
        // Text replacement is harder via CSS, needs JS
        if (override.text) {
           const els = document.querySelectorAll(override.selector);
           els.forEach(el => {
               // Only replace if it's a simple text node to avoid breaking React structure
               if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
                   el.innerText = override.text;
               }
           });
        }
      });
      
      styleTag.innerHTML = css;
      setActiveOverrides(customizationData.elementOverrides);
    }
  }, [customizationData]);

  // Text Observer disabled to prevent conflicts with React rendering
  /*
  useEffect(() => {
    if (!customizationData?.elementOverrides) return;
    
    const observer = new MutationObserver(() => {
        customizationData.elementOverrides.forEach(override => {
            if (override.text) {
                const els = document.querySelectorAll(override.selector);
                els.forEach(el => {
                    // Very careful text replacement
                     if (el.innerText !== override.text && el.children.length === 0) {
                        el.innerText = override.text;
                     }
                });
            }
        });
    });
    
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [customizationData]);
  */

  const updateOverride = (selector, styles, text) => {
    const current = customizationData?.elementOverrides || [];
    const existingIndex = current.findIndex(o => o.selector === selector);
    
    let newOverrides = [...current];
    if (existingIndex >= 0) {
        newOverrides[existingIndex] = {
            ...newOverrides[existingIndex],
            styles: { ...newOverrides[existingIndex].styles, ...styles },
            text: text !== undefined ? text : newOverrides[existingIndex].text
        };
    } else {
        newOverrides.push({ selector, styles, text });
    }
    
    // Optimistic update
    setActiveOverrides(newOverrides);
    
    saveMutation.mutate({
        elementOverrides: newOverrides,
        aiSettings: customizationData?.aiSettings || { name: 'Lykins AI' }
    });
  };

  const updateAISettings = (settings) => {
      saveMutation.mutate({
          ...customizationData,
          aiSettings: { ...customizationData?.aiSettings, ...settings }
      });
  };

  return (
    <CustomizationContext.Provider value={{ 
        customization: customizationData, 
        updateOverride, 
        updateAISettings,
        aiName: customizationData?.aiSettings?.name || 'Lykins AI'
    }}>
      {children}
    </CustomizationContext.Provider>
  );
}
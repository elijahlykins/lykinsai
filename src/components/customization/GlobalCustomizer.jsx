import React, { useState, useEffect, useRef } from 'react';
import { useCustomization } from './CustomizationContext';
import { SketchPicker } from 'react-color'; // Note: might not be installed, using standard input color if not
import { Type, Palette, Box, MousePointer2, UserCog, Trash2, X, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// Helper to generate unique selector
const getUniqueSelector = (el) => {
  if (el.id) return '#' + el.id;
  
  let path = [];
  while (el.parentElement) {
      let tag = el.tagName.toLowerCase();
      let siblings = Array.from(el.parentElement.children).filter(e => e.tagName.toLowerCase() === tag);
      if (siblings.length > 1) {
          let index = siblings.indexOf(el) + 1;
          tag += `:nth-of-type(${index})`;
      }
      path.unshift(tag);
      el = el.parentElement;
  }
  return path.join(' > ');
};

export default function GlobalCustomizer() {
  const { updateOverride, updateAISettings, customization } = useCustomization();
  const [contextMenu, setContextMenu] = useState(null);
  const [targetEl, setTargetEl] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [hoveredEl, setHoveredEl] = useState(null);
  
  // Editor State
  const [selectedTab, setSelectedTab] = useState('text');
  const [editValues, setEditValues] = useState({
      text: '',
      color: '#000000',
      backgroundColor: 'transparent',
      fontSize: '16px',
      fontWeight: 'normal',
      fontFamily: 'sans-serif',
      padding: '0px',
      borderRadius: '0px',
      border: 'none'
  });

  // Handle Right Click
  useEffect(() => {
    const handleContextMenu = (e) => {
       // Don't trigger on our own UI
       if (e.target.closest('.customizer-ui')) return;
       
       e.preventDefault();
       const el = e.target;
       setTargetEl(el);
       setContextMenu({ x: e.clientX, y: e.clientY });
       
       // Load initial values
       const computed = window.getComputedStyle(el);
       setEditValues({
           text: el.innerText,
           color: computed.color,
           backgroundColor: computed.backgroundColor,
           fontSize: computed.fontSize,
           fontWeight: computed.fontWeight,
           fontFamily: computed.fontFamily,
           padding: computed.padding,
           borderRadius: computed.borderRadius,
           border: computed.border
       });
    };

    // Highlight hover
    const handleMouseOver = (e) => {
        if (e.target.closest('.customizer-ui')) {
            setHoveredEl(null);
            return;
        }
        setHoveredEl(e.target);
        e.target.classList.add('customizer-hover');
    };
    
    const handleMouseOut = (e) => {
        e.target.classList.remove('customizer-hover');
        if (hoveredEl === e.target) setHoveredEl(null);
    };

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseout', handleMouseOut);

    // Inject styles for hover
    const style = document.createElement('style');
    style.innerHTML = `.customizer-hover { outline: 2px dashed #3b82f6 !important; cursor: context-menu !important; }`;
    document.head.appendChild(style);

    return () => {
        document.removeEventListener('contextmenu', handleContextMenu);
        document.removeEventListener('mouseover', handleMouseOver);
        document.removeEventListener('mouseout', handleMouseOut);
        style.remove();
    };
  }, [hoveredEl]);

  const handleSave = () => {
      if (!targetEl) return;
      const selector = getUniqueSelector(targetEl);
      
      const styles = {};
      if (editValues.color) styles.color = editValues.color;
      if (editValues.backgroundColor) styles.backgroundColor = editValues.backgroundColor;
      if (editValues.fontSize) styles.fontSize = editValues.fontSize;
      if (editValues.fontWeight) styles.fontWeight = editValues.fontWeight;
      if (editValues.fontFamily) styles.fontFamily = editValues.fontFamily;
      if (editValues.padding) styles.padding = editValues.padding;
      if (editValues.borderRadius) styles.borderRadius = editValues.borderRadius;
      if (editValues.border) styles.border = editValues.border;

      updateOverride(selector, styles, editValues.text);
      setEditorOpen(false);
      setContextMenu(null);
      setTargetEl(null);
  };

  const handleAiNameSave = (name) => {
      updateAISettings({ name });
  };

  return (
    <div className="customizer-ui">
      {contextMenu && (
        <div 
            className="fixed z-[9999] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl rounded-lg py-2 w-56 animate-in fade-in zoom-in duration-100"
            style={{ top: contextMenu.y, left: contextMenu.x }}
        >
           <div className="px-3 py-2 text-xs font-semibold text-gray-500 border-b border-gray-100 dark:border-gray-800 mb-1">
              Customize Element
           </div>
           <button 
             onClick={() => { setEditorOpen(true); setContextMenu(null); }}
             className="w-full text-left px-4 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
           >
              <Palette className="w-4 h-4" /> Edit Styles
           </button>
           <button 
             onClick={() => { 
                 const newName = prompt("Enter new AI Bot Name:", customization?.aiSettings?.name);
                 if (newName) handleAiNameSave(newName);
                 setContextMenu(null);
             }}
             className="w-full text-left px-4 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200"
           >
              <UserCog className="w-4 h-4" /> Rename AI Bot
           </button>
           <button 
             onClick={() => setContextMenu(null)}
             className="w-full text-left px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2 text-sm text-red-600"
           >
              <X className="w-4 h-4" /> Cancel
           </button>
        </div>
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="bg-white dark:bg-[#1f1d1d] max-w-md customizer-ui">
           <DialogHeader>
             <DialogTitle>Customize Element</DialogTitle>
           </DialogHeader>
           
           <Tabs value={selectedTab} onValueChange={setSelectedTab} className="w-full">
             <TabsList className="grid grid-cols-3 w-full">
               <TabsTrigger value="text">Text</TabsTrigger>
               <TabsTrigger value="typography">Typography</TabsTrigger>
               <TabsTrigger value="box">Box & Color</TabsTrigger>
             </TabsList>
             
             <div className="p-4 space-y-4">
                <TabsContent value="text" className="space-y-4 mt-0">
                   <div className="space-y-2">
                      <Label>Content</Label>
                      <Input 
                        value={editValues.text} 
                        onChange={(e) => setEditValues({...editValues, text: e.target.value})} 
                      />
                      <p className="text-xs text-gray-500">Note: Changing content might be overwritten by app logic.</p>
                   </div>
                </TabsContent>

                <TabsContent value="typography" className="space-y-4 mt-0">
                   <div className="grid grid-cols-2 gap-4">
                       <div className="space-y-2">
                          <Label>Font Size</Label>
                          <Input 
                            value={editValues.fontSize} 
                            onChange={(e) => setEditValues({...editValues, fontSize: e.target.value})} 
                          />
                       </div>
                       <div className="space-y-2">
                          <Label>Font Weight</Label>
                          <Select 
                            value={String(editValues.fontWeight)} 
                            onValueChange={(v) => setEditValues({...editValues, fontWeight: v})}
                          >
                             <SelectTrigger><SelectValue /></SelectTrigger>
                             <SelectContent>
                                <SelectItem value="normal">Normal</SelectItem>
                                <SelectItem value="bold">Bold</SelectItem>
                                <SelectItem value="100">Thin</SelectItem>
                                <SelectItem value="900">Black</SelectItem>
                             </SelectContent>
                          </Select>
                       </div>
                   </div>
                   <div className="space-y-2">
                      <Label>Font Color</Label>
                      <div className="flex gap-2">
                         <Input 
                           type="color" 
                           value={editValues.color.includes('#') ? editValues.color : '#000000'} 
                           onChange={(e) => setEditValues({...editValues, color: e.target.value})}
                           className="w-12 h-10 p-1"
                         />
                         <Input 
                           value={editValues.color} 
                           onChange={(e) => setEditValues({...editValues, color: e.target.value})} 
                         />
                      </div>
                   </div>
                   <div className="space-y-2">
                      <Label>Font Family</Label>
                      <Input 
                        value={editValues.fontFamily} 
                        onChange={(e) => setEditValues({...editValues, fontFamily: e.target.value})} 
                      />
                   </div>
                </TabsContent>

                <TabsContent value="box" className="space-y-4 mt-0">
                   <div className="space-y-2">
                      <Label>Background Color</Label>
                      <div className="flex gap-2">
                         <Input 
                           type="color" 
                           value={editValues.backgroundColor.includes('#') ? editValues.backgroundColor : '#ffffff'} 
                           onChange={(e) => setEditValues({...editValues, backgroundColor: e.target.value})}
                           className="w-12 h-10 p-1"
                         />
                         <Input 
                           value={editValues.backgroundColor} 
                           onChange={(e) => setEditValues({...editValues, backgroundColor: e.target.value})} 
                         />
                      </div>
                   </div>
                   <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                          <Label>Padding</Label>
                          <Input 
                            value={editValues.padding} 
                            onChange={(e) => setEditValues({...editValues, padding: e.target.value})} 
                          />
                       </div>
                       <div className="space-y-2">
                          <Label>Border Radius</Label>
                          <Input 
                            value={editValues.borderRadius} 
                            onChange={(e) => setEditValues({...editValues, borderRadius: e.target.value})} 
                          />
                       </div>
                   </div>
                   <div className="space-y-2">
                      <Label>Border</Label>
                      <Input 
                        value={editValues.border} 
                        onChange={(e) => setEditValues({...editValues, border: e.target.value})} 
                      />
                   </div>
                </TabsContent>
             </div>
             
             <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-gray-100 dark:border-gray-800">
                 <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
                 <Button onClick={handleSave}>Save Changes</Button>
             </div>
           </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Brain, Loader2, Download, Sparkles } from 'lucide-react';
// ❌ Removed base44 import

export default function MindMapGenerator({ note, allNotes, onUpdate }) {
  const [mindMap, setMindMap] = useState(note.mind_map || null);
  const [isGenerating, setIsGenerating] = useState(false);

  const generateMindMap = async () => {
    setIsGenerating(true);
    try {
      const connectedNotesContent = note.connected_notes 
        ? allNotes
            .filter(n => n && note.connected_notes.includes(n.id))
            .map(n => `- ${n.title}: ${n.content?.substring(0, 100) || ''}`)
            .join('\n')
        : 'No connected notes';

      // ⚠️ Removed attachment fetching (your proxy can't fetch URLs)
      // If needed later, add a separate route like /api/fetch-url

      const prompt = `Create a mind map structure for this note and its connections.

Main Note:
Title: ${note.title}
Content: ${note.content}
Tags: ${note.tags?.join(', ') || 'None'}

Connected Notes:
${connectedNotesContent}

Create a hierarchical mind map with:
1. Central node (main note)
2. Primary branches (main themes/concepts)
3. Secondary branches (sub-topics, connected ideas)
4. Connections (relationships between nodes)

Return ONLY a JSON object with this structure:
{
  "central": { "id": "string", "label": "string", "color": "string" },
  "branches": [
    {
      "id": "string",
      "label": "string",
      "color": "string",
      "subnodes": [
        { "id": "string", "label": "string" }
      ]
    }
  ],
  "connections": [
    { "from": "string", "to": "string", "label": "string" }
  ]
}`;

      const response = await fetch('http://localhost:3001/api/ai/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', prompt })
      });

      if (!response.ok) throw new Error('AI request failed');
      const { response: aiText } = await response.json();

      let mindMapData = null;
      try {
        mindMapData = JSON.parse(aiText);
      } catch (e) {
        // Fallback parsing
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            mindMapData = JSON.parse(jsonMatch[0]);
          } catch {}
        }
      }

      if (mindMapData) {
        setMindMap(mindMapData);
        if (onUpdate) {
          onUpdate({ mind_map: mindMapData });
        }
      }
    } catch (error) {
      console.error('Error generating mind map:', error);
    } finally {
      setIsGenerating(false);
    }
  };

  const exportMindMap = () => {
    const svg = document.getElementById('mindmap-svg');
    if (svg) {
      const svgData = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `mindmap-${note.title || 'untitled'}.svg`;
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="clay-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-black dark:text-white flex items-center gap-2">
          <Brain className="w-5 h-5 text-gray-600" />
          Mind Map
        </h3>
        {mindMap && (
          <Button
            onClick={exportMindMap}
            variant="ghost"
            size="sm"
            className="text-gray-600 hover:text-black"
          >
            <Download className="w-4 h-4" />
          </Button>
        )}
      </div>

      {isGenerating ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-blue" />
        </div>
      ) : !mindMap ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <p className="text-sm text-gray-500 mb-4">Generate a mind map to visualize this note and its connections.</p>
          <Button onClick={generateMindMap} className="bg-blue-600 text-white hover:bg-blue-700">
            <Sparkles className="w-4 h-4 mr-2" />
            Generate Mind Map
          </Button>
        </div>
      ) : mindMap && mindMap.central && mindMap.branches ? (
        <div className="space-y-4">
          <svg
            id="mindmap-svg"
            viewBox="0 0 800 600"
            className="w-full h-auto bg-dark-lighter rounded-lg"
          >
            {/* Central node */}
            <circle
              cx="400"
              cy="300"
              r="60"
              fill={mindMap.central?.color || '#8db4d4'}
              opacity="0.3"
            />
            <text
              x="400"
              y="305"
              textAnchor="middle"
              fill="black"
              fontSize="14"
              fontWeight="bold"
            >
              {mindMap.central?.label || 'Central'}
            </text>

            {/* Branches */}
            {mindMap.branches.filter(b => b).map((branch, idx) => {
              const angle = (idx * 360) / mindMap.branches.length;
              const radians = (angle * Math.PI) / 180;
              const branchX = 400 + Math.cos(radians) * 200;
              const branchY = 300 + Math.sin(radians) * 200;

              return (
                <g key={branch.id || idx}>
                  <line
                    x1="400"
                    y1="300"
                    x2={branchX}
                    y2={branchY}
                    stroke={branch?.color || '#b8a4d4'}
                    strokeWidth="2"
                    opacity="0.5"
                  />
                  
                  <circle
                    cx={branchX}
                    cy={branchY}
                    r="45"
                    fill={branch?.color || '#b8a4d4'}
                    opacity="0.3"
                  />
                  <text
                    x={branchX}
                    y={branchY + 5}
                    textAnchor="middle"
                    fill="black"
                    fontSize="12"
                  >
                    {branch?.label?.substring(0, 15) || 'Branch'}
                  </text>

                  {/* Subnodes */}
                  {branch.subnodes?.filter(s => s).map((subnode, subIdx) => {
                    const subAngle = angle + ((subIdx - branch.subnodes.length / 2) * 30);
                    const subRadians = (subAngle * Math.PI) / 180;
                    const subX = branchX + Math.cos(subRadians) * 100;
                    const subY = branchY + Math.sin(subRadians) * 100;

                    return (
                      <g key={subnode.id || subIdx}>
                        <line
                          x1={branchX}
                          y1={branchY}
                          x2={subX}
                          y2={subY}
                          stroke="#8dd4b8"
                          strokeWidth="1"
                          opacity="0.4"
                        />
                        <circle
                          cx={subX}
                          cy={subY}
                          r="25"
                          fill="#8dd4b8"
                          opacity="0.2"
                        />
                        <text
                          x={subX}
                          y={subY + 4}
                          textAnchor="middle"
                          fill="black"
                          fontSize="10"
                        >
                          {subnode?.label?.substring(0, 10) || 'Node'}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>

          <Button
            onClick={() => {
              setMindMap(null);
              generateMindMap();
            }}
            variant="outline"
            className="w-full bg-transparent border-gray-300 text-black hover:bg-gray-100"
          >
            Regenerate
          </Button>
        </div>
      ) : null}
    </div>
  );
}
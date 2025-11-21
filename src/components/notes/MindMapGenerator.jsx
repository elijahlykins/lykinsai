import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Brain, Loader2, Download } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function MindMapGenerator({ note, allNotes, onUpdate }) {
  const [mindMap, setMindMap] = useState(note.mind_map || null);
  const [isGenerating, setIsGenerating] = useState(false);

  const generateMindMap = async () => {
    setIsGenerating(true);
    try {
      // Get connected notes content
      const connectedNotesContent = note.connected_notes 
        ? allNotes
            .filter(n => n && note.connected_notes.includes(n.id))
            .map(n => `- ${n.title}: ${n.content.substring(0, 100)}`)
            .join('\n')
        : 'No connected notes';

      // Fetch content from attached links/videos
      let attachmentContext = '';
      if (note.attachments && note.attachments.length > 0) {
        const linkAttachments = note.attachments.filter(a => a.type === 'link');
        for (const attachment of linkAttachments.slice(0, 3)) {
          try {
            const fetchedContent = await base44.integrations.Core.InvokeLLM({
              prompt: `Fetch and summarize the key content from this URL: ${attachment.url}. Focus on main ideas, key points, and important information.`,
              add_context_from_internet: true
            });
            attachmentContext += `\n\nContent from ${attachment.name || attachment.url}:\n${fetchedContent}`;
          } catch (error) {
            console.error('Error fetching attachment content:', error);
          }
        }
      }

      const mindMapData = await base44.integrations.Core.InvokeLLM({
        prompt: `Create a mind map structure for this note and its connections.

Main Note:
Title: ${note.title}
Content: ${note.content}${attachmentContext}
Tags: ${note.tags?.join(', ') || 'None'}

Connected Notes:
${connectedNotesContent}

Create a hierarchical mind map with:
1. Central node (main note)
2. Primary branches (main themes/concepts)
3. Secondary branches (sub-topics, connected ideas)
4. Connections (relationships between nodes)

Return as a structured tree with nodes and their relationships.`,
        response_json_schema: {
          type: 'object',
          properties: {
            central: { 
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                color: { type: 'string' }
              }
            },
            branches: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  color: { type: 'string' },
                  subnodes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        label: { type: 'string' }
                      }
                    }
                  }
                }
              }
            },
            connections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  label: { type: 'string' }
                }
              }
            }
          }
        }
      });

      setMindMap(mindMapData);
      
      // Save to note
      if (onUpdate) {
        await onUpdate({ mind_map: mindMapData });
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
      link.download = `mindmap-${note.title}.svg`;
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  React.useEffect(() => {
    // Only generate if not already saved
    if (!note.mind_map) {
      generateMindMap();
    }
  }, []);

  return (
    <div className="clay-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-black flex items-center gap-2">
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
                <g key={branch.id}>
                  {/* Line from center to branch */}
                  <line
                    x1="400"
                    y1="300"
                    x2={branchX}
                    y2={branchY}
                    stroke={branch?.color || '#b8a4d4'}
                    strokeWidth="2"
                    opacity="0.5"
                  />
                  
                  {/* Branch node */}
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
                      <g key={subnode.id}>
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
import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Network, Loader2, Sparkles, ZoomIn, ZoomOut, Maximize2, Link2, Eye } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function EnhancedKnowledgeGraph({ notes, onSelectNote, onUpdateConnections }) {
  const [graphData, setGraphData] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [viewMode, setViewMode] = useState('force'); // force, cluster, hierarchy
  const [zoom, setZoom] = useState(1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const canvasRef = React.useRef(null);
  const nodesRef = React.useRef([]);
  const animationRef = React.useRef(null);

  useEffect(() => {
    if (notes.length > 0) {
      const cachedGraph = localStorage.getItem('lykinsai_graph_cache');
      if (cachedGraph) {
        try {
          const parsed = JSON.parse(cachedGraph);
          setGraphData(parsed);
          return;
        } catch (e) {
          console.error('Error parsing graph cache', e);
        }
      }
      // Initial build only if no cache exists
      if (!graphData && !cachedGraph) {
        buildGraph();
      }
    }
  }, []); // Only run on mount, don't rebuild automatically on notes change

  useEffect(() => {
    if (graphData) {
      drawGraph();
    }
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [graphData, zoom]);

  const buildGraph = async () => {
    setIsAnalyzing(true);
    try {
      // Limit to 40 recent notes to prevent rate limits
      const notesContext = notes.slice(0, 40).filter(n => n).map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 300)}\nTags: ${n.tags?.join(', ') || 'None'}\nFolder: ${n.folder || 'Uncategorized'}`
      ).join('\n\n---\n\n');

      const analysis = await base44.integrations.Core.InvokeLLM({
        prompt: `Analyze these notes and identify semantic relationships between them. For each pair of related notes, provide:
1. The relationship type (similar_topic, builds_on, contrasts_with, references, complementary)
2. Relationship strength (0.0 to 1.0)
3. Brief explanation

Notes:
${notesContext}

Find meaningful connections based on content, themes, and ideas - not just keyword matches.`,
        response_json_schema: {
          type: 'object',
          properties: {
            relationships: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  from_id: { type: 'string' },
                  to_id: { type: 'string' },
                  type: { type: 'string' },
                  strength: { type: 'number' },
                  explanation: { type: 'string' }
                }
              }
            },
            clusters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  note_ids: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        }
      });

      const newGraphData = {
        nodes: notes.filter(n => n).map(n => ({
          id: n.id,
          title: n.title,
          color: n.color || 'lavender',
          tags: n.tags || [],
          folder: n.folder || 'Uncategorized',
          connectionCount: 0
        })),
        edges: analysis.relationships || [],
        clusters: analysis.clusters || []
      };

      setGraphData(newGraphData);
      localStorage.setItem('lykinsai_graph_cache', JSON.stringify(newGraphData));

    } catch (error) {
      console.error('Error building graph:', error);
      // Fallback to basic graph
      setGraphData({
        nodes: notes.filter(n => n).map(n => ({
          id: n.id,
          title: n.title,
          color: n.color || 'lavender',
          tags: n.tags || [],
          folder: n.folder || 'Uncategorized',
          connectionCount: 0
        })),
        edges: [],
        clusters: []
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const drawGraph = () => {
    const canvas = canvasRef.current;
    if (!canvas || !graphData) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;

    // Initialize node positions
    if (nodesRef.current.length === 0) {
      if (viewMode === 'cluster') {
        positionByCluster();
      } else if (viewMode === 'hierarchy') {
        positionByHierarchy();
      } else {
        positionForceDirected();
      }
    }

    const animate = () => {
      ctx.clearRect(0, 0, width, height);

      // Apply physics (only in force mode)
      if (viewMode === 'force') {
        applyForces();
      }

      // Draw edges with cleaner lines
      graphData.edges.forEach(edge => {
        const fromNode = nodesRef.current.find(n => n.id === edge.from_id);
        const toNode = nodesRef.current.find(n => n.id === edge.to_id);
        
        if (fromNode && toNode) {
          const colors = {
            similar_topic: '#b8a4d4',
            builds_on: '#8dd4b8',
            contrasts_with: '#d4b8a4',
            references: '#8db4d4',
            complementary: '#b8d48d'
          };

          const color = colors[edge.type] || colors.similar_topic;
          const strength = edge.strength || 0.5;

          ctx.beginPath();
          ctx.moveTo(fromNode.x * zoom, fromNode.y * zoom);
          ctx.lineTo(toNode.x * zoom, toNode.y * zoom);
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.4 + (strength * 0.4);
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      });

      // Draw nodes as clean colored dots
      nodesRef.current.forEach(node => {
        if (!node) return;
        
        const colors = {
          lavender: '#b8a4d4',
          mint: '#8dd4b8',
          blue: '#8db4d4',
          peach: '#d4b8a4'
        };

        const baseRadius = 8;
        const radius = baseRadius + Math.min((node.connectionCount || 0) * 1.5, 8);
        
        // Draw shadow
        ctx.beginPath();
        ctx.arc(node.x * zoom + 1, node.y * zoom + 1, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.fill();

        // Draw node dot
        ctx.beginPath();
        ctx.arc(node.x * zoom, node.y * zoom, radius, 0, Math.PI * 2);
        ctx.fillStyle = colors[node.color || 'lavender'] || colors.lavender;
        ctx.fill();

        // Draw border if selected
        if (selectedNode?.id === node.id) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Draw label below node
        ctx.fillStyle = '#000000';
        ctx.font = `${Math.max(10, 11 * zoom)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fontWeight = '500';
        ctx.textAlign = 'center';
        const text = node.title.length > 18 ? node.title.substring(0, 18) + '...' : node.title;
        const textY = node.y * zoom + radius + 16;
        
        // Draw text background for readability
        const textMetrics = ctx.measureText(text);
        const padding = 4;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(
          node.x * zoom - textMetrics.width / 2 - padding,
          textY - 10,
          textMetrics.width + padding * 2,
          14
        );
        
        // Draw text
        ctx.fillStyle = '#000000';
        ctx.fillText(text, node.x * zoom, textY);
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    // Handle click
    const handleClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / zoom;
      const y = (e.clientY - rect.top) / zoom;

      nodesRef.current.forEach(node => {
        const dist = Math.sqrt((node.x - x) ** 2 + (node.y - y) ** 2);
        if (dist < 30) {
          setSelectedNode(node);
          onSelectNote(notes.find(n => n.id === node.id));
        }
      });
    };

    canvas.addEventListener('click', handleClick);
    return () => canvas.removeEventListener('click', handleClick);
  };

  const positionForceDirected = () => {
    const width = canvasRef.current.offsetWidth;
    const height = canvasRef.current.offsetHeight;

    nodesRef.current = graphData.nodes.map(node => ({
      ...node,
      x: Math.random() * width,
      y: Math.random() * height,
      vx: 0,
      vy: 0,
      connectionCount: graphData.edges.filter(e => e.from_id === node.id || e.to_id === node.id).length
    }));
  };

  const positionByCluster = () => {
    const width = canvasRef.current.offsetWidth;
    const height = canvasRef.current.offsetHeight;
    const clusters = graphData.clusters;

    if (clusters.length === 0) {
      positionForceDirected();
      return;
    }

    nodesRef.current = [];
    clusters.forEach((cluster, clusterIdx) => {
      const angle = (clusterIdx / clusters.length) * Math.PI * 2;
      const clusterX = width / 2 + Math.cos(angle) * 200;
      const clusterY = height / 2 + Math.sin(angle) * 200;

      cluster.note_ids.forEach((noteId, noteIdx) => {
        const node = graphData.nodes.find(n => n.id === noteId);
        if (node) {
          const subAngle = (noteIdx / cluster.note_ids.length) * Math.PI * 2;
          nodesRef.current.push({
            ...node,
            x: clusterX + Math.cos(subAngle) * 80,
            y: clusterY + Math.sin(subAngle) * 80,
            vx: 0,
            vy: 0,
            connectionCount: graphData.edges.filter(e => e.from_id === node.id || e.to_id === node.id).length
          });
        }
      });
    });
  };

  const positionByHierarchy = () => {
    const width = canvasRef.current.offsetWidth;
    const height = canvasRef.current.offsetHeight;

    // Sort by connection count
    const sortedNodes = [...graphData.nodes].sort((a, b) => {
      const aCount = graphData.edges.filter(e => e.from_id === a.id || e.to_id === a.id).length;
      const bCount = graphData.edges.filter(e => e.from_id === b.id || e.to_id === b.id).length;
      return bCount - aCount;
    });

    const layers = Math.ceil(Math.sqrt(sortedNodes.length));
    nodesRef.current = sortedNodes.map((node, idx) => {
      const layer = Math.floor(idx / layers);
      const posInLayer = idx % layers;
      return {
        ...node,
        x: (width / (layers + 1)) * (posInLayer + 1),
        y: (height / (layers + 1)) * (layer + 1),
        vx: 0,
        vy: 0,
        connectionCount: graphData.edges.filter(e => e.from_id === node.id || e.to_id === node.id).length
      };
    });
  };

  const applyForces = () => {
    const width = canvasRef.current.offsetWidth;
    const height = canvasRef.current.offsetHeight;

    nodesRef.current.forEach((node, i) => {
      if (!node) return;
      
      // Repulsion
      nodesRef.current.forEach((other, j) => {
        if (i !== j && other) {
          const dx = node.x - other.x;
          const dy = node.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 2000 / (dist * dist);
          node.vx += (dx / dist) * force;
          node.vy += (dy / dist) * force;
        }
      });

      // Attraction for connected nodes
      graphData.edges.forEach(edge => {
        let connected = null;
        if (edge.from_id === node.id) {
          connected = nodesRef.current.find(n => n.id === edge.to_id);
        } else if (edge.to_id === node.id) {
          connected = nodesRef.current.find(n => n.id === edge.from_id);
        }

        if (connected) {
          const dx = connected.x - node.x;
          const dy = connected.y - node.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = dist * 0.002 * (edge.strength || 0.5);
          node.vx += dx * force;
          node.vy += dy * force;
        }
      });

      // Center attraction
      node.vx += (width / 2 - node.x) * 0.0001;
      node.vy += (height / 2 - node.y) * 0.0001;

      // Apply velocity
      node.x += node.vx;
      node.y += node.vy;
      node.vx *= 0.85;
      node.vy *= 0.85;

      // Bounds
      node.x = Math.max(50, Math.min(width - 50, node.x));
      node.y = Math.max(50, Math.min(height - 50, node.y));
    });
  };

  const findConnectionSuggestions = async () => {
    if (!selectedNode) return;

    setIsAnalyzing(true);
    try {
      const selectedNote = notes.find(n => n.id === selectedNode.id);
      const otherNotes = notes.filter(n => n.id !== selectedNode.id);
      const existingConnections = graphData.edges
        .filter(e => e.from_id === selectedNode.id || e.to_id === selectedNode.id)
        .map(e => e.from_id === selectedNode.id ? e.to_id : e.from_id);

      const unconnectedNotes = otherNotes.filter(n => !existingConnections.includes(n.id));

      if (unconnectedNotes.length === 0) {
        setSuggestions([]);
        setShowSuggestions(true);
        return;
      }

      const notesContext = unconnectedNotes.map(n => 
        `ID: ${n.id}\nTitle: ${n.title}\nContent: ${n.content.substring(0, 200)}`
      ).join('\n\n---\n\n');

      const suggestionResults = await base44.integrations.Core.InvokeLLM({
        prompt: `Given this note:
Title: ${selectedNote.title}
Content: ${selectedNote.content.substring(0, 300)}

And these other notes:
${notesContext}

Suggest up to 5 notes that would be most valuable to connect with the given note. For each, explain why the connection would be meaningful.`,
        response_json_schema: {
          type: 'object',
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  note_id: { type: 'string' },
                  reason: { type: 'string' },
                  type: { type: 'string' }
                }
              }
            }
          }
        }
      });

      setSuggestions(suggestionResults.suggestions || []);
      setShowSuggestions(true);
    } catch (error) {
      console.error('Error finding suggestions:', error);
      setSuggestions([]);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const applyConnection = async (suggestion) => {
    try {
      const fromNote = notes.find(n => n.id === selectedNode.id);
      const toNote = notes.find(n => n.id === suggestion.note_id);

      if (fromNote && toNote) {
        // Update both notes with new connections
        const fromConnections = [...new Set([...(fromNote.connected_notes || []), toNote.id])];
        const toConnections = [...new Set([...(toNote.connected_notes || []), fromNote.id])];

        await base44.entities.Note.update(fromNote.id, { connected_notes: fromConnections });
        await new Promise(resolve => setTimeout(resolve, 500));
        await base44.entities.Note.update(toNote.id, { connected_notes: toConnections });

        setSuggestions(suggestions.filter(s => s.note_id !== suggestion.note_id));
        if (onUpdateConnections) onUpdateConnections();
      }
    } catch (error) {
      console.error('Error applying connection:', error);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center justify-between p-4 bg-white border-b border-gray-200">
        <div className="flex items-center gap-3">
          <Network className="w-5 h-5 text-black" />
          <h3 className="font-semibold text-black">Knowledge Graph</h3>
          {selectedNode && (
            <Badge className="bg-blue-100 text-blue-800">{selectedNode.title}</Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Select value={viewMode} onValueChange={setViewMode}>
            <SelectTrigger className="w-32 h-8 text-xs bg-white border-gray-300 text-black">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-white border-gray-200">
              <SelectItem value="force">Force Layout</SelectItem>
              <SelectItem value="cluster">Clustered</SelectItem>
              <SelectItem value="hierarchy">Hierarchical</SelectItem>
            </SelectContent>
          </Select>

          <Button
            onClick={() => setZoom(Math.max(0.5, zoom - 0.1))}
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 border-gray-300 text-black hover:bg-gray-100"
          >
            <ZoomOut className="w-4 h-4" />
          </Button>

          <Button
            onClick={() => setZoom(Math.min(2, zoom + 0.1))}
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 border-gray-300 text-black hover:bg-gray-100"
          >
            <ZoomIn className="w-4 h-4" />
          </Button>

          <Button
            onClick={() => {
              nodesRef.current = [];
              buildGraph();
            }}
            disabled={isAnalyzing}
            size="sm"
            className="bg-black text-white hover:bg-gray-800 h-8 text-xs"
          >
            {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
            Rebuild
          </Button>

          {selectedNode && (
            <Button
              onClick={findConnectionSuggestions}
              disabled={isAnalyzing}
              size="sm"
              className="bg-blue-600 text-white hover:bg-blue-700 h-8 text-xs"
            >
              <Link2 className="w-3 h-3 mr-1" />
              Suggest Connections
            </Button>
          )}
        </div>
      </div>

      {/* Graph Canvas */}
      <div className="flex-1 relative">
        {isAnalyzing && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center z-10">
            <div className="text-center">
              <Loader2 className="w-8 h-8 animate-spin text-black mx-auto mb-2" />
              <p className="text-sm text-black">Analyzing relationships...</p>
            </div>
          </div>
        )}
        <canvas ref={canvasRef} className="w-full h-full bg-gray-50" />
      </div>

      {/* Legend */}
      <div className="p-3 bg-white border-t border-gray-200">
        <div className="flex flex-wrap gap-4 text-xs text-gray-600">
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5" style={{backgroundColor: '#b8a4d4'}}></div>
            <span>Similar Topic</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5" style={{backgroundColor: '#8dd4b8'}}></div>
            <span>Builds On</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5" style={{backgroundColor: '#d4b8a4'}}></div>
            <span>Contrasts</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5" style={{backgroundColor: '#8db4d4'}}></div>
            <span>References</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5" style={{backgroundColor: '#b8d48d'}}></div>
            <span>Complementary</span>
          </div>
        </div>
      </div>

      {/* Connection Suggestions Dialog */}
      <Dialog open={showSuggestions} onOpenChange={setShowSuggestions}>
        <DialogContent className="bg-white border-gray-200 max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-black">Connection Suggestions for "{selectedNode?.title}"</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4 max-h-96 overflow-auto">
            {suggestions.length > 0 ? (
              suggestions.map((suggestion, idx) => {
                const note = notes.find(n => n.id === suggestion.note_id);
                if (!note) return null;
                return (
                  <Card key={idx} className="p-4 bg-gray-50 border-gray-200">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h4 className="font-medium text-black">{note.title}</h4>
                          <Badge className="text-xs bg-blue-100 text-blue-800">{suggestion.type}</Badge>
                        </div>
                        <p className="text-sm text-gray-600 mb-2">{suggestion.reason}</p>
                        <p className="text-xs text-gray-500 line-clamp-2">{note.content}</p>
                      </div>
                      <Button
                        onClick={() => applyConnection(suggestion)}
                        size="sm"
                        className="bg-black text-white hover:bg-gray-800"
                      >
                        Connect
                      </Button>
                    </div>
                  </Card>
                );
              })
            ) : (
              <p className="text-center text-gray-500 py-8">
                {isAnalyzing ? 'Finding suggestions...' : 'No new connection suggestions found'}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
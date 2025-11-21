import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '../../utils';

export default function KnowledgeGraph({ notes, selectedNoteId, onSelectNote }) {
  const canvasRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;

    // Create nodes
    const nodes = notes.filter(note => note).map((note, index) => ({
      id: note.id,
      title: note.title,
      x: Math.random() * (width - 100) + 50,
      y: Math.random() * (height - 100) + 50,
      vx: 0,
      vy: 0,
      connected: note.connected_notes || [],
      color: note.color || 'lavender',
      isSelected: note.id === selectedNoteId
    }));

    // Physics simulation
    const simulate = () => {
      ctx.clearRect(0, 0, width, height);

      // Apply forces
      nodes.forEach((node, i) => {
        if (!node) return;
        
        // Repulsion between nodes
        nodes.forEach((other, j) => {
          if (i !== j && other) {
            const dx = node.x - other.x;
            const dy = node.y - other.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = 1000 / (dist * dist);
            node.vx += (dx / dist) * force;
            node.vy += (dy / dist) * force;
          }
        });

        // Attraction to connected nodes
        if (node.connected && Array.isArray(node.connected)) {
          node.connected.forEach(connectedId => {
            const connected = nodes.find(n => n && n.id === connectedId);
            if (connected) {
              const dx = connected.x - node.x;
              const dy = connected.y - node.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const force = dist * 0.001;
              node.vx += dx * force;
              node.vy += dy * force;
            }
          });
        }

        // Center attraction
        const centerX = width / 2;
        const centerY = height / 2;
        node.vx += (centerX - node.x) * 0.0001;
        node.vy += (centerY - node.y) * 0.0001;

        // Apply velocity with damping
        node.x += node.vx;
        node.y += node.vy;
        node.vx *= 0.85;
        node.vy *= 0.85;

        // Keep in bounds
        node.x = Math.max(30, Math.min(width - 30, node.x));
        node.y = Math.max(30, Math.min(height - 30, node.y));
      });

      // Draw connections
      ctx.strokeStyle = 'rgba(184, 164, 212, 0.2)';
      ctx.lineWidth = 2;
      nodes.forEach(node => {
        if (!node || !node.connected) return;
        node.connected.forEach(connectedId => {
          const connected = nodes.find(n => n && n.id === connectedId);
          if (connected) {
            ctx.beginPath();
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(connected.x, connected.y);
            ctx.stroke();
          }
        });
      });

      // Draw nodes
      nodes.forEach(node => {
        if (!node || !node.x || !node.y) return;
        
        const colors = {
          lavender: '#b8a4d4',
          mint: '#8dd4b8',
          blue: '#8db4d4',
          peach: '#d4b8a4'
        };

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.isSelected ? 20 : 15, 0, Math.PI * 2);
        ctx.fillStyle = colors[node.color] || colors.lavender;
        ctx.fill();

        if (node.isSelected) {
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 3;
          ctx.stroke();
        }

        // Draw title
        if (node.title) {
          ctx.fillStyle = '#000';
          ctx.font = '12px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(
            node.title.length > 20 ? node.title.substring(0, 20) + '...' : node.title,
            node.x,
            node.y + 30
          );
        }
      });

      requestAnimationFrame(simulate);
    };

    simulate();

    // Handle click
    const handleClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      nodes.forEach(node => {
        if (!node) return;
        const dist = Math.sqrt((node.x - x) ** 2 + (node.y - y) ** 2);
        if (dist < 20) {
          onSelectNote(node.id);
        }
      });
    };

    canvas.addEventListener('click', handleClick);

    return () => {
      canvas.removeEventListener('click', handleClick);
    };
  }, [notes, selectedNoteId, onSelectNote]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full bg-dark-lighter rounded-lg"
    />
  );
}
import React from 'react';
import { motion } from 'framer-motion';
import { Brain, Search, HelpCircle, BarChart3, Network, Lightbulb } from 'lucide-react';

export default function MarginButton({ 
  id, 
  type, 
  onClick, 
  top, 
  text 
}) {
  const getIcon = () => {
    switch (type) {
      case 'definition':
        return <Search className="w-4 h-4 text-white group-hover:scale-110 transition-transform" />;
      case 'questions':
        return <HelpCircle className="w-4 h-4 text-white group-hover:scale-110 transition-transform" />;
      case 'swot':
        return <BarChart3 className="w-4 h-4 text-white group-hover:scale-110 transition-transform" />;
      case 'thought':
        return <Brain className="w-4 h-4 text-white group-hover:scale-110 transition-transform" />;
      case 'connections':
        return <Network className="w-4 h-4 text-white group-hover:scale-110 transition-transform" />;
      case 'answer':
        return <Lightbulb className="w-4 h-4 text-white group-hover:scale-110 transition-transform" />;
      default:
        return <Brain className="w-4 h-4 text-white group-hover:scale-110 transition-transform" />;
    }
  };

  const getTitle = () => {
    switch (type) {
      case 'definition':
        return `Definition: ${text}`;
      case 'questions':
        return `Questions: ${text}`;
      case 'swot':
        return `SWOT Analysis: ${text}`;
      case 'thought':
        return `AI Thought: ${text}`;
      case 'connections':
        return `Connected Ideas: ${text}`;
      case 'answer':
        return `Answer: ${text}`;
      default:
        return text;
    }
  };

  const getGradient = () => {
    switch (type) {
      case 'definition':
        return 'from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600';
      case 'questions':
        return 'from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600';
      case 'swot':
        return 'from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600';
      case 'thought':
        return 'from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600';
      case 'connections':
        return 'from-orange-500 to-pink-500 hover:from-orange-600 hover:to-pink-600';
      case 'answer':
        return 'from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600';
      default:
        return 'from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600';
    }
  };

  return (
    <motion.button
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -10 }}
      onClick={onClick}
      style={{
        position: 'absolute',
        left: '8px',
        top: `${top}px`,
        transform: 'translateY(-50%)'
      }}
      className={`w-8 h-8 rounded-full bg-gradient-to-br ${getGradient()} shadow-lg hover:shadow-xl transition-all flex items-center justify-center group z-10 pointer-events-auto`}
      title={getTitle()}
    >
      {getIcon()}
    </motion.button>
  );
}


import React from 'react';
import 'react-quill/dist/quill.bubble.css';

export default function RichTextRenderer({ content, className = '' }) {
  if (!content) return null;
  
  return (
    <div className={`rich-text-content ${className}`}>
      <style>{`
        .rich-text-content { font-size: 1rem; line-height: 1.6; }
        .rich-text-content h1 { font-size: 1.875rem; font-weight: 700; margin-top: 1.5em; margin-bottom: 0.5em; }
        .rich-text-content h2 { font-size: 1.5rem; font-weight: 600; margin-top: 1.25em; margin-bottom: 0.5em; }
        .rich-text-content h3 { font-size: 1.25rem; font-weight: 600; margin-top: 1em; margin-bottom: 0.5em; }
        .rich-text-content p { margin-bottom: 0.75em; }
        .rich-text-content ul { list-style-type: disc; padding-left: 1.5em; margin-bottom: 0.75em; }
        .rich-text-content ol { list-style-type: decimal; padding-left: 1.5em; margin-bottom: 0.75em; }
        .rich-text-content blockquote { border-left: 4px solid #e5e7eb; padding-left: 1em; margin-left: 0; font-style: italic; color: #6b7280; }
        .dark .rich-text-content blockquote { border-color: #4b5563; color: #9ca3af; }
        .rich-text-content pre { background-color: #1f2937; color: #e5e7eb; padding: 1em; border-radius: 0.5rem; overflow-x: auto; margin-bottom: 0.75em; font-family: monospace; }
        .rich-text-content a { color: #3b82f6; text-decoration: underline; }
        .dark .rich-text-content a { color: #60a5fa; }
        .rich-text-content img { max-width: 100%; height: auto; border-radius: 0.5rem; }
      `}</style>
      <div dangerouslySetInnerHTML={{ __html: content }} />
    </div>
  );
}
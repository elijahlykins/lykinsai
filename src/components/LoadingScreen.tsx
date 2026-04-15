import React from "react";

type LoadingScreenProps = {
  isLoading: boolean;
  children?: React.ReactNode;
};

export default function LoadingScreen({ isLoading, children }: LoadingScreenProps) {
  if (!isLoading) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white dark:bg-[#0b0b0f]">
      <span className="loading-typewriter text-lg font-medium text-black dark:text-white">
        Getting things ready...
      </span>
      <style>{`
        .loading-typewriter {
          display: inline-block;
          overflow: hidden;
          white-space: nowrap;
          border-right: 2px solid currentColor;
          width: 0;
          animation: typewriter 1.8s steps(23) forwards, blink 0.6s step-end infinite;
        }
        @keyframes typewriter {
          to { width: 23ch; }
        }
        @keyframes blink {
          50% { border-color: transparent; }
        }
      `}</style>
    </div>
  );
}

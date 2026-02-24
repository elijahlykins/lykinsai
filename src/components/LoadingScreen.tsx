import React from "react";

type LoadingScreenProps = {
  isLoading: boolean;
  children?: React.ReactNode;
};

export default function LoadingScreen({ isLoading, children }: LoadingScreenProps) {
  if (!isLoading) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-b from-[#0f0f23] to-[#1a1a2e]">
      <div className="rounded-xl border border-white/20 bg-white/10 backdrop-blur-md shadow-2xl px-8 py-6 text-center">
        <div className="text-xl font-semibold text-white">Omnia</div>
        <div className="mt-2 text-sm text-white/70">Loading your workspace...</div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <span className="h-2 w-2 rounded-full bg-white/70 animate-bounce [animation-delay:-0.2s]" />
          <span className="h-2 w-2 rounded-full bg-white/70 animate-bounce [animation-delay:-0.1s]" />
          <span className="h-2 w-2 rounded-full bg-white/70 animate-bounce" />
        </div>
      </div>
    </div>
  );
}

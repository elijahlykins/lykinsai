import React from "react";
import LyknLogoRevealLoader from "@/components/LyknLogoRevealLoader";

type LoadingScreenProps = {
  isLoading: boolean;
  children?: React.ReactNode;
};

export default function LoadingScreen({ isLoading, children }: LoadingScreenProps) {
  if (!isLoading) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--app-background,#ececeb)]">
      <LyknLogoRevealLoader size={88} className="text-[#0968c4] dark:text-white" />
    </div>
  );
}

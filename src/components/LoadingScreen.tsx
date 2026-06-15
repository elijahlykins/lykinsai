import React from "react";
import LyknLogoRevealLoader from "@/components/LyknLogoRevealLoader";

type LoadingScreenProps = {
  isLoading: boolean;
  children?: React.ReactNode;
};

export default function LoadingScreen({ isLoading, children }: LoadingScreenProps) {
  if (!isLoading) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white dark:bg-[#0d0d0d]">
      <LyknLogoRevealLoader size={88} className="text-[#1a4ee2] dark:text-white" />
    </div>
  );
}

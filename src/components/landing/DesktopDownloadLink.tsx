import type { ReactNode } from "react";
import { trackDesktopDownload } from "@/lib/analytics";
import {
  desktopDownloadUrl,
  type DesktopDownloadPlatform,
  type DesktopDownloadSource,
} from "@/lib/desktopDownload";

/** Installer link that records a first-party download event (and a GA4
    file_download when analytics consent is on) before GitHub serves the file. */
export default function DesktopDownloadLink({
  platform,
  source = "website",
  className,
  children,
}: {
  platform: DesktopDownloadPlatform;
  source?: DesktopDownloadSource;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={desktopDownloadUrl(platform, source)}
      onClick={() => trackDesktopDownload(platform)}
    >
      {children}
    </a>
  );
}

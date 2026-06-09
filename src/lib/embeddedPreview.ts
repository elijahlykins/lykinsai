/** Shared query-param helpers for iframe-embedded app surfaces. */
export function readEmbeddedPreviewParams(search: string): {
  isEmbedded: boolean;
} {
  const params = new URLSearchParams(search);
  return {
    isEmbedded: params.get("embedded") === "1",
  };
}

export function isEmbeddedSurfacePath(pathname: string): boolean {
  return (
    pathname === "/vault" ||
    pathname === "/app"
  );
}

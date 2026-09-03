import type { BrowserSurfaceContext } from "@/lib/lyknChat/browserChatSend";

export const BROWSER_PAGE_TEXT_BUDGET = 12000;

export type BrowserPageSnapshot = {
  url?: string;
  title?: string;
  text?: string;
};

export function boundBrowserPage(
  page: { url?: string; title?: string; text?: string } | null | undefined,
): BrowserPageSnapshot | undefined {
  if (!page) return undefined;
  const url = String(page.url || "").trim().slice(0, 2000);
  const title = String(page.title || "").trim().slice(0, 500);
  const text = String(page.text || "").trim().slice(0, BROWSER_PAGE_TEXT_BUDGET);
  if (!url && !title && !text) return undefined;
  return {
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
  };
}

/** Home sends never attach page context. Only an explicit browser surface. */
export function browserPageContextForRequest(
  surfaceContext?: BrowserSurfaceContext | null,
): BrowserPageSnapshot | undefined {
  if (!surfaceContext || surfaceContext.surface !== "browser") return undefined;
  return boundBrowserPage(surfaceContext.page);
}

export async function fetchTrustedBrowserTabPage(
  tabId: string,
): Promise<BrowserPageSnapshot | undefined> {
  const id = String(tabId || "").trim();
  if (!id) return undefined;
  try {
    const lykn =
      typeof window !== "undefined"
        ? (
            window as {
              lykn?: {
                getBrowserTabPageContext?: (tabId: string) => Promise<unknown>;
              };
            }
          ).lykn
        : null;
    if (typeof lykn?.getBrowserTabPageContext !== "function") return undefined;
    const res = await lykn.getBrowserTabPageContext(id);
    const row = res && typeof res === "object" ? (res as Record<string, unknown>) : null;
    if (!row || row.ok === false) return undefined;
    return boundBrowserPage({
      url: String(row.url || ""),
      title: String(row.title || ""),
      text: String(row.text || ""),
    });
  } catch {
    return undefined;
  }
}

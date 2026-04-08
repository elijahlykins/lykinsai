declare global {
  interface Window {
    instgrm?: { Embeds: { process: () => void } };
    FB?: { XFBML: { parse: (el?: HTMLElement) => void } };
    tiktokEmbed?: unknown;
  }
}

type ScriptState = { loaded: boolean; loading: Promise<void> | null };

const state: Record<string, ScriptState> = {
  instagram: { loaded: false, loading: null },
  tiktok: { loaded: false, loading: null },
  facebook: { loaded: false, loading: null },
};

function insertScript(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

export function loadInstagramEmbed(): Promise<void> {
  if (state.instagram.loaded) return Promise.resolve();
  if (state.instagram.loading) return state.instagram.loading;
  state.instagram.loading = insertScript(
    "https://www.instagram.com/embed.js",
    "instagram-embed-sdk"
  ).then(() => {
    state.instagram.loaded = true;
  });
  return state.instagram.loading;
}

export function loadTikTokEmbed(): Promise<void> {
  if (state.tiktok.loaded) return Promise.resolve();
  if (state.tiktok.loading) return state.tiktok.loading;
  state.tiktok.loading = insertScript(
    "https://www.tiktok.com/embed.js",
    "tiktok-embed-sdk"
  ).then(() => {
    state.tiktok.loaded = true;
  });
  return state.tiktok.loading;
}

export function loadFacebookEmbed(): Promise<void> {
  if (state.facebook.loaded) return Promise.resolve();
  if (state.facebook.loading) return state.facebook.loading;
  // Facebook SDK requires a fb-root div in the DOM
  if (!document.getElementById("fb-root")) {
    const fbRoot = document.createElement("div");
    fbRoot.id = "fb-root";
    document.body.prepend(fbRoot);
  }
  state.facebook.loading = insertScript(
    "https://connect.facebook.net/en_US/sdk.js#xfbml=1&version=v21.0",
    "facebook-jssdk"
  ).then(() => {
    state.facebook.loaded = true;
  });
  return state.facebook.loading;
}

/**
 * Loads the correct embed SDK for a platform and then asks it to
 * re-process any unprocessed embed elements inside `container`.
 */
export async function loadAndProcessEmbed(
  platform: string,
  container?: HTMLElement | null
): Promise<void> {
  try {
    switch (platform) {
      case "instagram":
        await loadInstagramEmbed();
        window.instgrm?.Embeds?.process();
        break;
      case "tiktok":
        await loadTikTokEmbed();
        break;
      case "facebook":
        await loadFacebookEmbed();
        if (container) {
          window.FB?.XFBML?.parse(container);
        } else {
          window.FB?.XFBML?.parse();
        }
        break;
    }
  } catch (err) {
    console.warn(`[embedScripts] Failed to load ${platform} embed:`, err);
  }
}

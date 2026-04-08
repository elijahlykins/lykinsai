import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    webEmbed: {
      setWebEmbed: (options: { src: string; title?: string | null }) => ReturnType;
    };
  }
}

function isHttpUrl(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Generic page embed (iframe). Many sites block framing; when they do, the frame may stay empty.
 * YouTube should use the dedicated `youtube` node instead.
 */
export const WebEmbed = Node.create({
  name: "webEmbed",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-notes-web-embed]",
        getAttrs: (el) => {
          const iframe = (el as HTMLElement).querySelector("iframe");
          const src = iframe?.getAttribute("src") || (el as HTMLElement).getAttribute("data-src");
          if (!src) return false;
          return {
            src,
            title: iframe?.getAttribute("title") || null,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const src = String(node.attrs.src || "").trim();
    const title = String(node.attrs.title || "").trim() || "Embedded page";
    return [
      "div",
      mergeAttributes({
        "data-notes-web-embed": "",
        class:
          "notes-web-embed rounded-xl overflow-hidden border border-black/15 dark:border-white/15 my-3 w-full max-w-3xl bg-black/[0.04] dark:bg-white/[0.06]",
      }),
      [
        "iframe",
        mergeAttributes({
          src,
          title,
          width: "100%",
          height: "360",
          loading: "lazy",
          referrerpolicy: "no-referrer-when-downgrade",
          sandbox:
            "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-presentation",
          allowfullscreen: "true",
          class: "w-full h-[min(360px,56.25vw)] min-h-[200px] block bg-white dark:bg-black/20",
        }),
      ],
    ];
  },

  addCommands() {
    return {
      setWebEmbed:
        (options: { src: string; title?: string | null }) =>
        ({ commands }) => {
          const src = String(options.src || "").trim();
          if (!isHttpUrl(src)) return false;
          return commands.insertContent({
            type: this.name,
            attrs: { src, title: options.title ?? null },
          });
        },
    };
  },
});

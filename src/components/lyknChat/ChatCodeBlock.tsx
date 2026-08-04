import React, { useCallback, useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import {
  ResearchChartEmbed,
  ResearchSheetEmbed,
  ResearchStockEmbed,
} from "@/components/lyknChat/ResearchReportEmbeds";

/**
 * Recursively flattens react-markdown's `children` (which can be strings,
 * arrays, or wrapped elements) into the raw code text.
 */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as any)) {
    return extractText((node as any).props?.children);
  }
  return "";
}

function CodeBlockInner({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — no-op
    }
  }, [code]);

  return (
    <div className="my-3 rounded-lg overflow-hidden border border-white/10 bg-[#1e1e1e] text-[0.85em]">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/[0.04] border-b border-white/10">
        <span className="text-[11px] uppercase tracking-wide text-white/40 font-medium">
          {lang === "text" ? "code" : lang}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="text-[11px] text-white/50 hover:text-white/90 transition-colors px-1"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <Highlight code={code} language={lang} theme={themes.vsDark}>
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className="m-0 p-3 overflow-x-auto leading-[1.55] font-mono"
            style={{ ...style, background: "transparent" }}
          >
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (
                <div key={i} {...lineProps}>
                  {line.map((token, key) => {
                    const tokenProps = getTokenProps({ token });
                    return <span key={key} {...tokenProps} />;
                  })}
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

/**
 * Drop-in replacement for react-markdown's `code` renderer. Inline code keeps
 * the old chip styling; fenced blocks (className `language-*`) get Prism
 * syntax highlighting, a language label, and a copy button.
 */
export function ChatCodeBlock({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const isBlock = typeof className === "string" && className.startsWith("language-");
  if (!isBlock) {
    return (
      <code className="rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-[0.85em]">
        {children}
      </code>
    );
  }
  const lang = (className || "").replace(/^language-/, "").trim().toLowerCase() || "text";
  const code = extractText(children).replace(/\n$/, "");
  if (lang === "stock") return <ResearchStockEmbed code={code} />;
  if (lang === "chart") return <ResearchChartEmbed code={code} />;
  if (lang === "sheet" || lang === "spreadsheet" || lang === "csv") {
    return <ResearchSheetEmbed code={code} />;
  }
  return <CodeBlockInner code={code} lang={lang} />;
}

export default ChatCodeBlock;

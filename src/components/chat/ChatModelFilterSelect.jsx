import React, { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import {
  CHAT_MODEL_FILTER_ALL,
  buildChatModelFilterOptions,
} from "@/lib/board/chatModelKey";

/** Dropdown under Chats in the sidebar — All chats + each model the user has. */
export default function ChatModelFilterSelect({
  customModels = [],
  value = CHAT_MODEL_FILTER_ALL,
  onChange,
  className = "",
}) {
  const options = useMemo(
    () => buildChatModelFilterOptions(customModels),
    [customModels],
  );

  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full appearance-none text-left text-[0.6875rem] pl-2.5 pr-7 py-1 rounded-md hover:bg-blue-500/15 transition-colors text-black/60 dark:text-white/60 bg-transparent border-0 outline-none cursor-pointer"
        aria-label="Filter chats by model"
      >
        <option value={CHAT_MODEL_FILTER_ALL}>All chats</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-black/40 dark:text-white/40"
        aria-hidden
      />
    </div>
  );
}

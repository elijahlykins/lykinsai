// Custom skills for one Bot — named playbooks the user teaches it.
// They persist on the bot and ride into its runtime identity, so later
// turns follow them without the user restating the playbook.
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  BOT_SKILL_INSTRUCTIONS_MAX,
  BOT_SKILL_LIMIT,
  BOT_SKILL_NAME_MAX,
} from "@/lib/bots/botStore";
import { editBotSkill, forgetBotSkill, teachBotSkill } from "@/lib/bots/botsClient";

export default function BotSkillsPanel({ bot }) {
  const skills = Array.isArray(bot.skills) ? bot.skills : [];
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editingId, setEditingId] = useState("");
  const [error, setError] = useState("");
  const atLimit = skills.length >= BOT_SKILL_LIMIT;

  const resetDraft = () => {
    setName("");
    setInstructions("");
    setEditingId("");
    setError("");
  };

  const save = () => {
    const nextName = name.trim();
    const nextInstructions = instructions.trim();
    if (!nextName || !nextInstructions) {
      setError("Give the skill a name and tell it what to do.");
      return;
    }
    if (editingId) {
      editBotSkill(bot.id, editingId, { name: nextName, instructions: nextInstructions });
      resetDraft();
      return;
    }
    if (atLimit) {
      setError(`A bot can have ${BOT_SKILL_LIMIT} custom skills.`);
      return;
    }
    const taught = teachBotSkill(bot.id, { name: nextName, instructions: nextInstructions });
    if (!taught) {
      setError("Could not save that skill.");
      return;
    }
    resetDraft();
  };

  const startEdit = (skill) => {
    setEditingId(skill.id);
    setName(skill.name);
    setInstructions(skill.instructions);
    setError("");
  };

  return (
    <div className="rounded-2xl border border-black/10 p-4 dark:border-white/10">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-black/35 dark:text-white/35">
        {bot.name}&rsquo;s custom skills
      </p>
      <p className="mt-1 text-[0.72rem] text-black/40 dark:text-white/40">
        Teach {bot.name} a playbook. It will follow that skill whenever the work matches.
      </p>

      {skills.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {skills.map((skill) => (
            <li
              key={skill.id}
              className={`rounded-xl bg-black/[0.035] px-3 py-2.5 dark:bg-white/[0.05] ${
                editingId === skill.id ? "ring-1 ring-black/20 dark:ring-white/25" : ""
              }`}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8rem] font-medium">{skill.name}</p>
                  <p className="mt-0.5 line-clamp-3 text-[0.72rem] text-black/45 dark:text-white/45">
                    {skill.instructions}
                  </p>
                </div>
                <button
                  type="button"
                  title="Edit skill"
                  onClick={() => startEdit(skill)}
                  className="rounded-full p-1.5 text-black/40 transition-colors hover:bg-black/[0.06] hover:text-black/80 dark:text-white/40 dark:hover:bg-white/[0.09] dark:hover:text-white/90"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Delete skill"
                  onClick={() => {
                    if (editingId === skill.id) resetDraft();
                    forgetBotSkill(bot.id, skill.id);
                  }}
                  className="rounded-full p-1.5 text-black/30 transition-colors hover:bg-red-500/10 hover:text-red-500 dark:text-white/30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-[0.78rem] text-black/40 dark:text-white/45">
          No custom skills yet.
        </p>
      )}

      <div className="mt-4">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError("");
          }}
          placeholder="Skill name"
          maxLength={BOT_SKILL_NAME_MAX}
          disabled={!editingId && atLimit}
          className="w-full rounded-xl border border-black/10 bg-transparent px-3 py-2 text-[0.8rem] outline-none placeholder:text-black/30 focus:border-black/25 disabled:opacity-40 dark:border-white/10 dark:placeholder:text-white/30 dark:focus:border-white/30"
        />
        <textarea
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value);
            if (error) setError("");
          }}
          placeholder={`What should ${bot.name} do when this skill applies?`}
          rows={4}
          maxLength={BOT_SKILL_INSTRUCTIONS_MAX}
          disabled={!editingId && atLimit}
          className="mt-2 w-full resize-none rounded-xl border border-black/10 bg-transparent px-3 py-2 text-[0.8rem] leading-relaxed outline-none placeholder:text-black/30 focus:border-black/25 disabled:opacity-40 dark:border-white/10 dark:placeholder:text-white/30 dark:focus:border-white/30"
        />
        {error ? (
          <p className="mt-1.5 text-[0.72rem] text-red-500/90">{error}</p>
        ) : (
          <p className="mt-1.5 text-[0.72rem] text-black/35 dark:text-white/35">
            {editingId
              ? "Save the changes, or cancel to keep the original."
              : atLimit
                ? `This bot already has ${BOT_SKILL_LIMIT} skills.`
                : "Name the skill, write the playbook, then add it."}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={(!editingId && atLimit) || !name.trim() || !instructions.trim()}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-black/85 py-2 text-[0.8rem] font-semibold text-white transition-colors hover:bg-black disabled:opacity-35 dark:bg-white dark:text-black dark:hover:bg-white/90"
          >
            {editingId ? (
              "Save skill"
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                Add skill
              </>
            )}
          </button>
          {editingId ? (
            <button
              type="button"
              onClick={resetDraft}
              className="rounded-xl px-3 py-2 text-[0.78rem] font-medium text-black/50 transition-colors hover:bg-black/[0.05] hover:text-black/80 dark:text-white/50 dark:hover:bg-white/[0.08] dark:hover:text-white/85"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

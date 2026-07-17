# App / Tool / Game Guide

How to structure an interactive artifact: mini-apps, utilities, calculators,
quizzes, games, prototypes. Colors and component recipes come from the
[DESIGN_SYSTEM] brief — this guide covers interaction structure and app craft.

## Shape the app before styling it

- List the views/screens first (e.g. quiz: start → question → results). Model them with a single `view` state and conditional rendering — never dead buttons or "coming soon".
- One screen = one job. A timer shows the time huge and the controls beneath it; settings live behind a toggle or secondary view, not beside the main action.
- Simple utility (converter, counter, single form) = ONE centered card (`max-w-md mx-auto`) on a soft page background, generous internal spacing. Don't invent tabs and panels a one-job tool doesn't need.
- Bigger apps get an app frame: compact header (title + key action), main working area, optional footer strip for status/meta.

## State & interaction rules

- All state in React (`useState`/`useReducer`). NO localStorage/sessionStorage — the sandboxed iframe drops them; the app must work fully in-memory.
- Every interactive element responds visibly: hover, active/pressed, focus ring (accent), and disabled states.
- Inputs validate inline (small red text under the field) — never `alert()`.
- Provide a reset/start-over affordance whenever the user builds up state.
- Keyboard support where it's natural: Enter submits, arrow keys navigate quizzes/games, Space pauses timers.

## Feedback & states (what separates a real app from a sketch)

- **Empty state**: friendly icon + one line + the action that fixes it ("No tasks yet — add your first one").
- **Progress**: bars or step dots for anything multi-step; count-ups for scores.
- **Success/completion**: a distinct moment — result screen, big number, confetti() when celebration fits the tone (games/quizzes yes, tax calculator no).
- **Error/failure**: gentle shake or red flash on the offending control, never a blocking wall of text.
- Transitions between views: framer-motion `AnimatePresence` fade/slide (150–250ms). Games can use springs; utilities stay subtle.

## Layout & sizing

- Touch-first targets: buttons `px-5 py-2.5` minimum, list rows `py-3`, gaps `gap-3+`.
- The primary action is visually loudest (solid accent); secondary actions are outline/ghost. One primary per screen.
- Number-heavy displays (timers, scores, totals) use `font-mono` or `font-display` at 3–5× body size — the number IS the interface.
- Keep the app usable at 375px wide: stack panels, keep controls reachable, no horizontal scroll.

## Content rules

- Ship with realistic seed data (sample tasks, plausible quiz questions with correct answers, sensible defaults) so the first render already demonstrates the app.
- Microcopy is short and does real work: button labels say what happens ("Start 25-min focus", not "Submit").

## Quality bar (self-check before returning)

- Every button/input/keyboard path actually works; no dead ends.
- Empty, in-progress, and finished states all designed.
- State resets cleanly; nothing crashes on double-click or rapid input.
- One accent family; spacing on a consistent scale; focus rings present.

# Loop

Every cycle:

1. **Observe** — read the structured page snapshot (URL, title, tabs,
   interactive elements, visible text). Element references (`e12`) are only
   valid for the snapshot they came from.
2. **Decide** — choose exactly one next action that makes progress toward the
   current plan step, or decide to finish, ask the user, or replan.
3. **Act** — issue the structured action. The browser controller executes it
   deterministically.
4. **Verify** — compare the resulting snapshot to the expected outcome. URL
   changes, new elements, changed text, and form values are evidence. A tool
   returning without error is NOT evidence of success.
5. **Update** — record the action and outcome in task state; update working
   memory with discovered facts; advance, retry, recover, or replan.

Termination: finish when the goal is achieved with evidence, when the user
must provide information or approval, when the task is impossible, or when
recovery has been exhausted. Never keep browsing after the goal is met.

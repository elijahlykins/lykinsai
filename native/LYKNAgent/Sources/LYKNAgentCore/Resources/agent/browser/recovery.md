# Recovery

When an action fails or verification shows no progress:

1. Get a fresh snapshot. Determine whether the page changed unexpectedly
   (popup, redirect, login wall, error page).
2. Determine whether the target moved, was renamed, or disappeared.
3. Search the new snapshot for an equivalent semantic target (same role and
   similar label) and retry with it.
4. If the element only exists visually, fall back to visual inspection
   (screenshot) before coordinate interaction.
5. If the current approach is invalid (site changed, feature missing,
   dead end), replan instead of retrying.
6. Ask the user only when information or permission genuinely requires them
   (credentials, ambiguous choices, approval for consequential actions).

Limits:

- At most 2 retries of essentially the same operation; then change strategy.
- Track what was already tried; never loop on a known-failed approach.
- If recovery and replanning are both exhausted, stop and report honestly
  what was attempted and where it failed.

# Subagent routing and visibility

## Goal
A helper the parent asks for (qa, reviewer) runs as that agent on its own model and shows in the BB sidebar. Asking for one agent never changes other threads in the project. Background helpers never block the parent.

## Done when
1. A background qa helper appears as a BB child thread within seconds, even after the parent's turn ends.
2. Native helpers keep the right agent and model. `bb thread spawn` asking for qa runs qa on the agent's model (not build).
3. A plain new thread in the same project runs as the default agent, not qa.
4. An unknown requested agent fails the turn with a visible message, never silently build.
5. The parent answers a new message while a background helper still runs.

## Shortest verification
One parent prompt (background qa + reviewer with sleep 60, plus one bb thread spawn asking for qa) -> sidebar screenshot; send "say hi" -> parent replies while helpers run; one plain new thread; one OpenCode DB query for agent/model.

## Decisions
- Agent's own model wins for subagent-mode agents.
- Fix both routes now. Plugin only. No commits unless asked.

# Automatic Update of documentation/flags.md

## Trigger & Frequency
At the end of **EVERY SINGLE PROMPT**, before returning your final response to the user, you MUST inspect and update `documentation/flags.md`.
You must do this autonomously without requiring the user to prompt or remind you.

## Instructions
1. Review all actions taken, code written, decisions made, risks, and potential edge cases in the current prompt.
2. Determine if there are any unresolved concerns, technical debt, potential architectural risks, or questions that need clarification.
3. Append a new entry to `documentation/flags.md` under `## Active & Historical Flags Log`:
   - Timestamp and prompt/phase summary
   - Status (`🔴 Open`, `🟡 In Progress`, or `✅ Clean`)
   - List of unresolved concerns (or explicitly state `None` if all checks and validations are clean)
   - Mitigation or next steps planned for upcoming phases
4. If an existing concern is resolved by the work done in the prompt, mark it resolved in `documentation/flags.md`.
5. Ensure the file formatting remains clean and consistent.

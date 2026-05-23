---
name: web-ui-worker
description: Use in Worker mode for web development tickets that involve user-facing UI changes. Enforces a fast loop. read the plan, make small UI changes, verify with Playwright CLI/browser and targeted Vitest, then finish with a happy-path E2E test and typecheck.
---

# Web UI Worker

Use this skill only after Worker mode has been selected by the top-level task workflow. Project instructions still win for exact commands, fixtures, route conventions, approval gates, and commit policy.

## 1. Read Plan and State Verification Intent

Before editing code:

1. Read the epic and ticket.
2. Identify affected routes, components, state, loaders/actions, APIs, and tests.
3. Summarize briefly:
   - intended UI change
   - affected user flow
   - likely files or areas
   - whether logic/state changes are expected
   - planned Playwright/Vitest/E2E/typecheck verification

If the user flow or expected UI behavior is unclear, ask before editing.

## 2. Fast Single-Task Feedback Loop

Work in small increments:

1. Make the smallest useful change.
2. Verify the changed behavior with the narrowest relevant tool.
3. Repeat until the ticket acceptance criteria are satisfied.

Do not start unrelated tickets. Do not run broad suites repeatedly unless targeted checks cannot give confidence.

## 3. UI Verification with Playwright CLI/Browser

For UI changes, use the project's Playwright CLI/browser tooling to inspect and interact with the affected page.

Preferred approach:

1. Start or reuse the dev server according to project scripts.
2. Open the relevant URL in a browser with Playwright CLI, for example using the project's equivalent of:
   - `pnpm exec playwright open <url>`
   - or a project-specific Playwright/browser helper
3. Verify the affected happy path manually through the browser:
   - page renders correctly
   - changed controls/content appear as expected
   - main interaction works
   - no obvious layout breakage
   - no console/runtime errors if the tooling exposes them

If a headed browser cannot be used in the current environment, explain the limitation and replace it with the closest targeted Playwright check available.

## 4. Logic Verification with Vitest

For logic, state, parsing, validation, reducers, hooks, utilities, loaders/actions, or business rules:

1. Run the most targeted Vitest test possible.
2. Add or update focused unit tests when changing logic.
3. Prefer targeted commands during development, such as the project equivalent of:
   - `pnpm vitest path/to/test --run`
   - `pnpm exec vitest path/to/test --run`
   - or a project-specific test script

Do not rely on E2E tests for logic edge cases when a fast unit test is more appropriate.

## 5. Finish with Happy-Path E2E

Before handing back for review, add or update one happy-path E2E test for the main user flow affected by the ticket.

Guidelines:

- Keep it short and deterministic.
- Use existing fixtures/helpers.
- Cover the primary user-visible path, not every edge case.
- Prefer one targeted spec over a broad suite.
- Run the specific E2E test you added or changed.

If a happy-path E2E test is genuinely not appropriate, state why and ask/confirm before skipping it.

## 6. Final Verification

Before finishing the Worker verification step, run:

1. targeted Playwright/browser verification for the UI change
2. targeted Vitest tests if logic changed
3. the targeted happy-path E2E test
4. the project's typecheck command

Use the project's exact commands when documented. Prefer narrow checks first, then the required final typecheck.

## 7. Stop at Project Approval Gate

If the project has an approval gate, stop after verification and present results. Do not close tickets, commit, or start another ticket until the user explicitly approves.

## 8. Report

Report concisely:

- files changed
- UI behavior verified in Playwright/browser
- Vitest command/result, if applicable
- E2E command/result
- typecheck command/result
- any limitation or skipped check with reason

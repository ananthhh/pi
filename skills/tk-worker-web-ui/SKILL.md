---
name: tk-worker-web-ui
description: Use in Worker mode for web development tickets with user-facing UI changes. Reads `playwright-cli` for browser verification, uses Vitest for logic, and finishes with a happy-path E2E test.
---

# Web UI Worker

Follow the workflow from `tk-worker`. This skill only provides the tools and verification responsibilities to use while working UI tickets.
Use the project's exact commands when documented.

## 1. Fast Loop

Make the smallest useful change. Verify with the narrowest tool. Repeat until acceptance criteria are met.

## 2. Browser Verification (playwright-cli)

Load `playwright-cli` for browser automation. For UI changes, use it to inspect the affected page:

```bash
# Open and navigate
playwright-cli open <url> --headed
playwright-cli snapshot

# Interact using refs from the snapshot
playwright-cli click e3
playwright-cli fill e5 "test"
playwright-cli snapshot
```

Keep the browser open in correct page during checkpoint to be verified by user
Multiple tabs can be opened if different states involved

## 3. Logic Verification (Vitest)

For logic, state, hooks, utilities, loaders/actions, or business rules:

1. Run the most targeted Vitest test:
   ```bash
   pnpm vitest path/to/test --run
   ```
2. Add or update focused unit tests when changing logic.
3. Do not rely on E2E for edge cases a unit test can cover.

## 4. Happy-Path E2E

Before finishing, add or update one short happy-path E2E test for the main user flow. Use existing fixtures. Run the specific spec:

```bash
pnpm exec playwright test path/to/spec --run
```

If genuinely inappropriate, state why and confirm before skipping.

## 5. Final Verification

Run in this order:
1. Browser check (`playwright-cli` or targeted Playwright test)
2. Vitest for logic changes
3. Happy-path E2E spec
4. Project typecheck

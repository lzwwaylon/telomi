# Real E2E verification

When changing a user flow that can be triggered from the frontend, reproduce and verify it through the real page entry point. Start or confirm the development server first; use [Worktree commands](worktree-commands.md) for services and environment checks in a Worktree.

## Verification and completion criteria

Operate the product in a real browser and inspect the actual UI, interactions, state transitions, console and network errors, and final artifacts. Bug verification must cover the original reproduction flow. API responses or component tests alone do not prove the complete user flow works.

## Waiting and timeouts

Use Runtime's existing timeout settings for real E2E or Provider tests. If a wait seems long, first check Runtime access limits, Provider throttling and retry status, and whether the upstream service is still responding. Long waits within the configured limits are normal test behavior. Changes to timeout policy require separate, explicit behavioral review.

## Using an existing Goal

Copy an existing Goal into an isolated Worktree, then launch the product through `run`:

```bash
npm run worktree -- seed goal_existing_id
```

This command copies existing product and Runtime files, skips symbolic links, dependency caches and locks, and refuses to overwrite an existing Goal. Evaluation instance mode prevents background recovery and scheduling from taking ownership of the copied data.

This snapshot is only for product UI/Runtime verification and does not replace [Attestation](attestation.md). Keep private Goals, Browser Profiles and test artifacts out of Git.

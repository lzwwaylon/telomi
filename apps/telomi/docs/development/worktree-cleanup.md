# Worktree cleanup

Use this page before stopping or removing a Worktree. Stop its owned processes before removing it:

```bash
npm run worktree -- stop
npm run worktree -- remove
```

`stop` stops the current Worktree's managed commands and services. Commands must be started through the unified `run` entry point so cleanup can follow ownership. If stopping fails, diagnose the failure before deleting the directory.

Removal requires a clean working directory and a HEAD already merged into local `dev` or `main`. After merging through GitHub, synchronize the local target branch first; updating only the remote-tracking ref does not update the local branch. The main checkout and Worktrees with `main` or `dev` checked out are protected.

Removal preserves branches and stashes. Stop also shuts down the pg0 instance named for this Worktree; its database files are in the Worktree's data directory, so removal deletes them and leaves only pg0's small runtime record under `~/.pg0/instances`. Remove additionally deletes the Worktree's agent-browser socket directory. Do not use forced removal to discard unfinished work.

Closing the terminal that runs `run` is equivalent to stopping that command. If a Worktree is deleted without `stop`, either by deleting its directory directly or by forcing `git worktree remove`, its process ownership records remain in the main checkout's Git directory. Any subsequent Worktree command stops its remaining commands, services and browser and deletes its socket directory.

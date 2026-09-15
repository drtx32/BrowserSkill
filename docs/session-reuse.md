## Session reuse

The agent-facing session name is `default`; the daemon resolves it to a live physical session. `bsk bootstrap` calls the same resolver used by normal tool commands and only creates a new physical session when the saved logical session is no longer active.

The runtime registry is authoritative. Persisted state is not trusted by age, Chromium major version, or a workspace path. Browser connection identity is the extension instance id; an explicitly launched process is recorded by executable path and PID for diagnostics. Browser login state stays in the user's existing browser profile.

An explicit `bsk session stop` clears the logical mapping. A later bootstrap can create a fresh Agent Window in the same connected browser.

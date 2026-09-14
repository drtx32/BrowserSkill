## Browser bootstrap

`bsk bootstrap` prepares the persistent BrowserSkill workflow:

1. Ensure the local daemon is available.
2. Reuse any browser already connected through the BrowserSkill extension.
3. If none is connected and `--browser-executable` is supplied, start that executable with no profile or data-directory arguments.
4. Wait for the extension handshake, then ensure the stable logical `default` session.
5. Save recoverable `.bsk-session` metadata below the BSK home.

The command does not create profiles, copy cookies, inspect browser versions, or terminate a browser. `--browser` selects an instance id (or label) when more than one connection is online. The saved browser instance id and launch executable/PID are diagnostic identity; Chromium major version is not an identity key.

Examples:

```text
bsk bootstrap
bsk bootstrap --browser-executable "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
bsk bootstrap --browser <instance-id> --wait-ms 60000
```

The daemon's live registry remains authoritative. `.bsk-session` is recovery metadata only and may be replaced when a physical session is recreated.

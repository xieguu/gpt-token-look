# Security

Codex Token Lens is a local-only dashboard. The server binds to `127.0.0.1` and reads usage metadata from the local Codex data directory.

It does not read or upload:

- conversation body text
- tool output bodies
- `auth.json`
- API keys
- GitHub credentials

When enabled, the server starts the locally installed Codex CLI app-server and asks it for account-level rate limits and token usage. Authentication remains owned by Codex; Token Lens does not read or parse `auth.json`. Set `TOKEN_LENS_OFFICIAL_USAGE=0` to use local JSONL snapshots only.

The API endpoint is local:

```http
GET http://127.0.0.1:4173/api/usage
```

Do not expose the local server through a public tunnel unless you understand that session names, local paths, token totals, model names, usage timestamps, and rate-limit snapshots can be visible to whoever can access the tunnel.

## Reporting

For security bugs, open a private report if GitHub private vulnerability reporting is enabled. Otherwise open an issue without including secrets or private session data.

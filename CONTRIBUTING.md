# Contributing

Thanks for helping improve Codex Token Lens.

## Local Setup

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:4173
```

## Checks

```bash
npm run check
npm test
```

## Pull Requests

- Keep the app dependency-light.
- Keep the server bound to `127.0.0.1`.
- Do not add code that reads conversation body text, auth files, API keys, GitHub credentials, or tool output bodies.
- Add tests for parsing, pricing, cache, and API behavior when changing server logic.

## Screenshot

Update `token-lens-preview.png` when the visible UI changes. Use a local Codex data fixture or a private data directory, and avoid publishing screenshots that reveal private paths or session names.

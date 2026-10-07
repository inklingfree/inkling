# Contributing

Thanks for wanting to help. inkling is a small personal project, so keep changes focused.

- **Setup:** see the README. `npm install`, then `npm start` with a `.env` and `data/users.json`.
- **Check:** there's no build step and no test suite. Run `npm run typecheck` before every pull request, and
  `node --check browser/server.mjs` if you touched the browser service.
- **Testing by hand:** use a scratch data directory (`INKLING_DATA_DIR=/tmp/inkling-test`) and a spare WhatsApp
  number. Never run anything that sends messages, emails or invites to real people as a test.
- **Style:** TypeScript, ESM, small modules, short comments that say why, no framework. Match what's there.
  User-facing text never uses em dashes.
- **Design principles:** read the "Design principles" section of [CLAUDE.md](CLAUDE.md). Pull requests that weaken
  them (confirmations before sending as someone, privacy of a linked WhatsApp, encryption at rest) won't be merged.
- **Secrets:** never commit `.env`, anything from `data/`, real phone numbers or email addresses. Use the fake
  numbers from `users.example.json` (`4477009000xx`) in examples.
- **Security issues:** report them privately, see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the MIT License.

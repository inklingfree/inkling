# Security

inkling handles people's messages, email, calendars and, optionally, an admin's own WhatsApp. Security reports are
very welcome.

## Reporting a vulnerability

Please report privately through GitHub: on this repository, open the **Security** tab and choose **Report a
vulnerability**. Don't open a public issue for anything that could put someone's data or number at risk.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply as soon as
possible; this is a small personal project, so please allow a little time for a fix.

Things that are especially interesting:

- any way to make it send something (a WhatsApp message, an email, a calendar invite, a website's final step, a code
  change) without the person's own yes in a later message
- any way for a stranger, a web page, an email or a document to get it to add people, change roles or reveal another
  person's data
- anything that leaks one person's data into another person's chat or a group, or into the logs
- ways around the browser service's checks (private or local addresses, final-step detection, spending limits)

## What's protected, and how

- **Encrypted at rest** with AES-256-GCM and `INKLING_SECRET_KEY`: chat history and memory, Google refresh tokens,
  an admin's linked WhatsApp session and inbox, website cookies kept for the browser, and the per-chat files for
  reminders, lists, dates, watches, polls, auto-replies, travel and self-changes.
- **Not encrypted:** `data/users.json` (names, numbers, settings) and the assistant's own WhatsApp session in
  `data/auth/`. Whoever can read the data directory can take over the assistant's number, so keep it private.
- **Secrets** live in `.env` (or your host's settings) and `data/`, both gitignored. Losing `INKLING_SECRET_KEY` makes
  the encrypted data unreadable; leaking it exposes it.
- **Sending** as someone, and other irreversible steps, are confirmed in code: the exact preview is sent by code and
  only a yes in a later message, within 30 minutes, carries it out.
- **Google** sign-in uses OAuth with PKCE through single-use links that expire after 10 minutes and are bound to the
  person who asked for them.
- **Logs** record which tools ran, never their arguments, and the WhatsApp encryption library's session dumps
  (which include private keys) are filtered out.
- **Model provider:** messages go to your own Azure OpenAI deployment with `store: false`. Web search uses Grounding
  with Bing, which Microsoft runs outside Azure's data-protection terms.

## Known limits

- WhatsApp access is through Baileys, an unofficial client. A number can be banned by WhatsApp at any time.
- The model can be wrong or be manipulated by content it reads. The protections above are designed so that this can't
  turn into an unconfirmed send, but it can still give a wrong answer.

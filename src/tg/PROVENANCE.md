# Terminal Grid UI — vendored

`tokens.css`, `components.css`, `index.js`, and `components/*.js` are vendored
**verbatim** from the Terminal Grid Design system (the `terminal-grid-ui`
library), the agreed design language for this panel. Treat them as read-only —
style the panel by composing these components and referencing the `--tg-*`
tokens, not by editing the library.

Local additions (kept minimal and inside the token system):

- `tokens.css`: defined `--tg-glass-bg` / `--tg-glass-border`, which
  `components.css` references (header/hero) but the upstream library never
  defined. They resolve to existing surface/border tokens, so nothing is
  hardcoded.

The panel itself lives in `../control.html` and is served, along with this
directory, by `../control-server.js` (`GET /tg/*`).

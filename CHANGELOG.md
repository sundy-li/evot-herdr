# Changelog

## 0.2.0

- Replace the Bun runtime and test runner with Node.js 22.12+, TypeScript build output, and Vitest. The installable package has no runtime dependencies.
- Report `evot-herdr --resume <full-session-id>` to Herdr 0.9.2+ so panes can restore saved conversations after a server restart.
- Detect restore-argv support from the Herdr CLI; keep lifecycle and identity reporting on older versions.
- Preserve a wrapper-started `--env-file` as an absolute restore argument without persisting config contents or prompt text.
- Keep pane ownership across session switches; retain explicit-exit and EOF/signal release behavior.
- Register restore commands only after a successful ownership report, and retry failed registrations.
- Port executable discovery, signal exit status, bounded queries, and process-tree timeout cleanup to Node.js.
- Sync sequence generations before atomic replacement, and reject invalid process IDs before group cleanup.

Automatic restore requires Herdr 0.9.2+, a persisted evot conversation, both executables on the restored shell's PATH, and agent restore enabled. It restores context without automatically rerunning interrupted tools. Install the accompanying evot direct-ID lookup fix to resume sessions outside the old 20-session startup window.

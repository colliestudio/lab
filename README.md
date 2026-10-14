# Collie Studio lab

Prototypes and experiments, vibe-coded: no engineering bar, no shared tooling. Anything that matures moves to its own repo and gets rebuilt properly.

| dir | what |
|---|---|
| `pocs/canvas` | agent-native, local-first, multiplayer canvas |
| `pocs/artifact` | artifact kit: HTML pages agents make for reviews, plans, explainers (was recap-lab) |
| `pocs/demo` | Collie Demo: narrated, seekable DOM replays recorded by agents (was replay-lab) |

Each `pocs/<name>` is self-contained: its own `package.json`, lockfile and `mise.toml`. Run commands from inside it.

History: each project was imported with its full history rewritten under its dir (`git log -- pocs/<name>`). Side branches that weren't merged are tags `archive/<name>/<branch>`.

# Attribution

This project is distributed under AGPL-3.0-only. Copyright (c) 2026 Geek_L and contributors.

The initial delegation workflow was informed by the public source and behavior of
[BigPizzaV3/CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus), licensed under AGPL-3.0:

- `crates/codex-plus-core/src/agent_collaboration/mcp.rs`
- `crates/codex-plus-core/src/agent_collaboration/executor.rs`
- `crates/codex-plus-core/src/agent_collaboration/dsh.rs`
- `docs/agent-collaboration.md`

The implementation here is JavaScript and provides its own Harness plugin lifecycle,
native sidebar page, task queue, process runner, and stdio bridge. No CodexPlusPlus
binaries or bundled credentials are distributed.

Plugin integration follows the public APIs and documentation of
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
licensed under MIT. Harness is a separately installed runtime and is not bundled.

Runtime dependency `yaml` is licensed under ISC. Build dependency `esbuild` is MIT.
The UI imports React from the host runtime; React is not bundled in this repository.
Each dependency retains its own license.

# DiceTilt Agent Rules

Read `CLAUDE.md` and `documentation/` before coding. These rules extend them.

## Git

- **Conventional Commits:** `feat|fix|refactor|build|ci|chore|docs|style|perf|test`
- **Safe by default:** `git status` / `git diff` before edits. Push only when user asks.
- **No destructive ops** (`reset --hard`, `clean`, `restore`, `rm`) without explicit consent.
- **Prefer small, reviewable commits.** No repo-wide search/replace scripts.
- **Branch changes require user consent.**
- **Commit helper:** Use `./scripts/committer.ps1 "message" path1 path2` (Windows PowerShell) or `pwsh ./scripts/committer.ps1 "message" path1 path2` (Unix — PowerShell Core). The legacy `powershell` binary is not available on Unix; use `pwsh` instead.

## Build & Test

- **Before handoff:** Run `pnpm gate` (or `pnpm build && pnpm lint && pnpm test`)
- **Fix root cause**, not band-aids.
- **Add regression test** when fixing bugs (when it fits).
- **CI red:** Fix, push, repeat until green.

## Code

- **Keep files <~500 LOC;** split/refactor as needed.
- **Follow existing patterns** in `services/` and `packages/`.
- **Use repo package manager (pnpm);** no swaps without approval.
- **TypeScript strict mode;** no `any` without justification.

## Docs

- **Read `documentation/`** before coding.
- **Update docs** when behavior/API changes.
- **No ship without docs** for new behavior.

## Frontend

- **Avoid generic AI slop UI.**
- **Typography:** Pick a real font; avoid Inter/Roboto/Arial/system defaults.
- **Theme:** Commit to a palette; use CSS vars; bold accents over timid gradients.
- **Motion:** 1–2 high-impact moments (staggered reveal beats random micro-anim).

## Critical Thinking

- **Unsure:** Read more code; if still stuck, ask with short options.
- **Conflicts:** Call out; pick safer path.
- **Unrecognized changes:** Assume other agent; focus your changes. If it causes issues, stop and ask.

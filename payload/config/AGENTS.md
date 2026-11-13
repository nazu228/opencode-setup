## Architecture & Repo Rules

- **Dependency direction:** `Schema` -> `Core` / `Protocol` -> `Server`. Client runtime code may depend on `Schema` and `Protocol`, never `Core` or `Server`. `sdk` composes `Client`, `Core`, and `Server`.
- **SDK generation:** After changing public `Protocol` or Server `HttpApi`, run `bun run generate` from `packages/client`. Never edit generated client files directly.
- **Releases:** Do not add `.changeset` files; this repo uses its own release workflow.
- **Git workflow:** Base branches and worktrees on `origin/dev`, target PRs at `dev`, and diff against `origin/dev`.
- **Feature flags:** Gate new user-visible or risky behavior in `packages/schema/src/config/flag.ts` and read via `Flag.enabled("<key>")` from `@opencode/core/flag`. Mention the flag in the PR body. Remove the flag when shipping.

## Git Naming

- **Branches:** At most 3 words separated by hyphens, no slashes or prefixes (e.g. `session-recovery`, `fix-scroll-state`).
- **Commits & PR titles:** `type(scope): summary` using `feat`, `fix`, `docs`, `chore`, `refactor`, or `test` (e.g. `fix(tui): simplify thinking toggle styling`).

## Style Guide

- **Functions & Variables:** Keep logic inline unless a helper is reused, hides a complex boundary, or names a clear concept. Inline single-use variables and avoid unnecessary destructuring (prefer `obj.a` over `const { a } = obj`).
- **Validation & Control Flow:** Validate unknown data once at the owning boundary using Effect `Schema` (e.g. `Schema.UnknownFromJsonString`) and pass typed values inward. Avoid `try`/`catch` and defensive revalidation.
- **Scope discipline:** Before adding complexity for unlikely race or security edge cases, explain the failure mode, likelihood, and cost to get user buy-in first.
- **Types & APIs:** Rely on type inference, avoid `any`, use Bun APIs (`Bun.file()`), and prefer functional array methods (`flatMap`, `filter` with type guards, `map`) over loops.
- **Effect:** Bind services to variables before calling methods (`const foo = yield* Foo.Service; yield* foo.bar()`). Do not return `Effect` from synchronous helpers.
- **Imports:**
  - Never use aliased imports (`import { a as b }`), star imports (`import * as Foo`), or type-position `import("...")`.
  - Import exported namespaces by name (`import { Project } from "@opencode/core/project"` -> `Project.ID`).
  - Use dynamic imports for heavy branch-specific modules; bind destructured exports near the top of the narrowest scope that needs them.
- **Config & DB:** In `src/config`, re-export new modules at the top (`export * as ConfigAgent from "./agent.js"`). In Drizzle schemas, use `snake_case` field names so column strings aren't duplicated.

## Testing & Checks

- **Tests:** Never run tests from the repo root; run inside package directories (e.g. `packages/core`). Avoid mocks and `globalThis.*`; test real implementations. Before writing tests, read the matching skill in `.opencode/skills` (`unit-tests`, `tui-tests`, `app-e2e-tests`, or `component-tests`).
- **Verification:** Run `bun run check` from the root for full lint/typecheck. In individual packages, run `bun typecheck` (never raw `tsc`). If `bun check` and `tsc` disagree, `bun run typecheck:tsc` is the source of truth.

## Subsystem Guides (Read When Touching These Areas)

- **TUI (`packages/tui`):** Read `packages/tui/AGENTS.md` for `dev:live` testing, storybook fixtures (`OPENCODE_STORY`), and strict semantic theme token rules.
- **Desktop CDP (`packages/app`):** Read `packages/app/AGENTS.md` before attaching Playwright to a live desktop app.
- **Core & Server (`packages/core`, `packages/server`):** Read `packages/core/AGENTS.md` and `packages/server/AGENTS.md` before changing async plugin loading or session execution/inbox durability invariants.
- **New Endpoints:** New routes start under `/api/experimental/<group>/...` (`experimental.<group>.<method>`). See `packages/protocol/AGENTS.md` for graduation and deprecation alias rules.

<!-- context7 -->
Use the `ctx7` CLI to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, porting code between libraries, platforms, or SQL dialects, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer — your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, debugging, or reviewing code that does not depend on a library or platform API, or general programming concepts.

## Steps

1. Resolve library: `npx ctx7@latest library <name> "<what to look up>"` — use the official library name with proper punctuation (e.g., "Next.js" not "nextjs", "Customer.io" not "customerio", "Three.js" not "threejs")
2. Pick the best match (ID format: `/org/project`) by: exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results don't look right, try alternate names or queries (e.g., "next.js" not "nextjs", or rephrase the question)
3. Fetch docs: `npx ctx7@latest docs <libraryId> "<what to look up>"` — run a separate `docs` command per distinct concept if the question spans multiple topics, unless it's about how they interact
4. Answer using the fetched documentation

You MUST call `library` first to get a valid ID unless the user provides one directly in `/org/project` format. Be specific about what to look up in the library's documentation — specific and detailed queries return better results than vague single words, but keep each query to a single concept unless the question is about how concepts interact; combined multi-topic queries dilute ranking and return shallow results for each topic. Do not run more than 3 commands per question. Do not include sensitive information (API keys, passwords, credentials) in queries.

For version-specific docs, use `/org/project/version` from the `library` output (e.g., `/vercel/next.js/v16.2.9`).

If a command fails with a quota error, inform the user and suggest `npx ctx7@latest login` or setting `CONTEXT7_API_KEY` env var for higher limits. Do not silently fall back to training data.
<!-- context7 -->

## Project memory

Before non-trivial work in a project, read `DECISIONS.md` at the project root if it exists. After a durable decision, a rejected approach, or a discovered pitfall, append a short entry: context, decision, why, what was tried and failed, consequences. Keep it factual and useful for the next agent; do not duplicate changelog history.

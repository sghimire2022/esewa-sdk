# Contributing to esewa-sdk

Thanks for considering a contribution. This is a small, zero-dependency library, so the bar for merging is: correct, tested, and no new dependencies unless there's no reasonable way around it.

## Reporting bugs / proposing features

Open a [GitHub issue](https://github.com/sghimire2022/esewa-sdk/issues). For bugs, include:

- The SDK version, Node/Bun/Deno version, and runtime (Node, edge, etc.)
- A minimal reproduction (inputs, expected vs. actual behavior)
- Whether you're hitting eSewa's test (`rc-epay.esewa.com.np`) or production environment

For features, a quick description of the use case is more useful than a full design — happy to discuss the approach before you write code.

**Intent payment** (eSewa's app deeplink flow) isn't implemented yet; its public docs are incomplete. PRs for it are especially welcome.

## Development setup

```bash
git clone https://github.com/sghimire2022/esewa-sdk.git
cd esewa-sdk
npm install
```

```bash
npm test          # vitest
npm run typecheck
npm run build     # ESM + CJS + .d.ts into dist/
```

All three must pass before a PR is merged (`npm run prepublishOnly` runs all of them in sequence, same as CI).

To exercise the SDK against a real signed payment end-to-end, use one of the example apps in [`use-cases/`](use-cases) — see each one's own README for setup.

## Coding conventions

- **Zero runtime dependencies.** The SDK uses only Web Crypto and `fetch`, so it runs on Node 18+, Bun, Deno, and edge runtimes. A PR that adds a runtime dependency needs a strong justification.
- **Match the existing style**: typed errors via `EsewaError`, no silent fallbacks, amounts handled in integer paisa internally (see the "Notes" section in [README.md](README.md)).
- **Tests live in `test/`** (vitest) and should cover the behavior you're adding or fixing, not just happy paths — signature/callback code especially benefits from adversarial test cases (tampered data, malformed input, wrong product code).
- Keep PRs focused on one change. Unrelated formatting or refactors make review harder — split them out.

## Submitting a pull request

1. Fork the repo and create a branch off `main`.
2. Make your change, with tests.
3. Run `npm test && npm run typecheck && npm run build` locally.
4. Open a PR describing *why* the change is needed, not just what it does. Link any related issue.

By contributing, you agree your contributions are licensed under this project's [MIT license](LICENSE).

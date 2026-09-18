# Contributing

Issues and pull requests are welcome. Maintainers decide what enters the
release and retain control of labels, merges, signing, and publishing.

## Development setup

The app expects sibling checkouts of the engine and accessibility bridge:

```text
Work/
|-- unbiased-app/
|-- unbiased-app-engine/
`-- unbiased-ax/
```

Build the native components first, then run the app:

```bash
(cd ../unbiased-app-engine && make bundle)
(cd ../unbiased-ax && make bundle)
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm test
```

Do not include credentials, user data, local absolute paths, generated
release artifacts, or information copied from private systems.

Maintainers may apply the `ai-review` label after an initial review. Outside
contributors do not need to add or request that label.

By submitting a contribution, you agree that it may be distributed under
the repository's Apache-2.0 license. Report vulnerabilities through
[SECURITY.md](SECURITY.md), not a public issue.

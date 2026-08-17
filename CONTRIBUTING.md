# Contributing

## Development setup

```bash
npm install
npm run verify
```

The default test suite must remain offline and credential-free.

## Change expectations

- Preserve Consult / Integrated / Delegate semantics.
- Add focused regression tests for lifecycle, protocol, concurrency, or provider changes.
- Keep optional provider SDKs dynamically loaded.
- Document live-uncertified behavior as such.
- Update `STATUS.md`, relevant provider docs, and `CHANGELOG.md` when capabilities change.
- Never commit credentials, OAuth state, provider responses containing private data, or copied user workspaces.

## Provider adapters

Prefer configuration through `openai-chat` or `command`. A custom adapter should include:

- explicit capabilities;
- abort propagation;
- bounded streaming/buffers;
- error normalization;
- cleanup/disposal;
- history compatibility;
- offline tests with a fake/local server.

## Pull request verification

Include:

- problem and invariant;
- implementation summary;
- tests added/updated;
- `npm run verify` result;
- external live tests, if any, with provider/model/version/date and no secrets;
- known limitations or follow-up work.

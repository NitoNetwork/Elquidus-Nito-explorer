# Contributing

Contributions should preserve the explorer's public-data and exact-accounting
contracts. Orchard receivers, note ownership and transfer recipients are private;
never infer them from nullifiers, commitments or net value balance.

## Development baseline

1. Use the Node.js version in `.nvmrc` and install exactly the committed graph
   with `npm ci`.
2. Copy `settings.json.template` to the ignored `settings.json` only for local
   development. Never commit credentials, wallet material, database exports or
   operator evidence.
3. Keep monetary values exact. Use nitoshi integers or decimal strings at API
   boundaries; do not coerce chain amounts to JavaScript `Number`.
4. Keep all database and Core integration testing isolated from production.

Before opening a pull request, run:

```bash
npm audit --omit=dev
npm audit
npm run validate:publication
npm test
npm run test:v4
```

Changes to indexing, reorganization handling, RPC interpretation or monetary
accounting also require the isolated regtest integration test documented in
[`docs/nito-v4-orchard.md`](docs/nito-v4-orchard.md#validation).

Use clear English for source, identifiers, commit messages and public technical
documentation. Preserve existing copyright and third-party license notices.

# Dependency maintenance

Use Node.js 24 LTS, at least 24.22.3, and install the committed dependency graph
with `npm ci`. The `.nvmrc` file identifies the validated baseline. npm rejects
unsupported runtimes, and startup checks the runtime again. Do not run
`npm audit fix --force`, `npm update`, or download a supervisor during startup.
Review dependency changes and commit the resulting lockfile before installation.

Run both `npm audit --omit=dev` and `npm audit`. PM2 is a runtime dependency;
development-only audit results must not be used to exclude an active supervisor.
Audit results describe advisories known to the registry at the time of the check,
not a guarantee that the application has no vulnerabilities.

## Compatibility decisions

- Express remains on major 4 and Mongoose on major 8. MongoDB's driver remains
  on major 6. This preserves the existing application and database contracts.
- The obsolete request client is replaced by an Undici-backed GET adapter for
  market, price and other external HTTP integrations. It supports the options
  used in this repository: URL, JSON, headers, timeout and redirect control.
  Unsupported options fail explicitly. It honours HTTP/HTTPS proxy and
  `no_proxy` environment settings, limits decoded responses to 16 MiB and uses
  a 30-second absolute timeout unless the caller specifies another deadline.
  Core RPC continues to use its separate exact-number transport.
- PM2 is installed locally from the lockfile. Forever commands fail with
  migration instructions; they do not start or stop any service. See the
  [installation guide](../README.md) for the supported operating commands.
- Jasmine 5's `glob` dependency is narrowly overridden to 14.0.6. Its original
  version range includes vulnerable releases. The existing synchronous discovery
  API, patterns and exclusions were checked with the current test runner. Review
  this override when updating Jasmine; do not apply a global glob override.

## Validation after updates

On an isolated installation, run `npm ci`, both dependency audits, `npm test`,
`npm run test:v4` and the documented real Core integration test. The focused
tests include compressed-request parser errors, proxy subnet trust, external
provider failures, redirects, timeouts, proxy exclusions and supervisor lifecycle.
Compile the distributed themes and inspect the home, rich list, market and
transaction pages on desktop and mobile. Verify activation transitions on the
same explorer process. Keep production data and private test evidence outside
the repository.

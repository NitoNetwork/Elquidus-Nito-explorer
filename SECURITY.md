# Security policy

## Supported version

Security fixes are applied to the latest revision on `main`. Older commits and
locally modified deployments are not supported branches.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include credentials,
wallet material, private keys, RPC cookies, database exports or production data
in a report.

Use [GitHub private vulnerability reporting](https://github.com/NitoNetwork/Elquidus-Nito-explorer/security/advisories/new).
Describe the affected revision, impact, reproduction steps and a minimal sanitized
test case. The maintainers will acknowledge the report and coordinate disclosure
after the issue has been assessed and a fix is available.

Dependency advisories should identify the affected package and reachable explorer
code path. An automated advisory alone does not establish exploitability, but it
will be reviewed against the committed lockfile and supported Node.js runtime.

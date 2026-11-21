# Third-party notices

This project is derived from the eIquidus community explorer. The retained
copyright notices and BSD 3-Clause terms are in [`LICENSE`](LICENSE).

The distributed theme styles include Bootstrap 5.1.3 and Bootswatch 5.1.3 work,
licensed under the MIT License. Their copyright and license headers are preserved
in the generated files under `public/css/themes/`. The complete retained MIT
terms and attributions are in
[`licenses/BOOTSTRAP-BOOTSWATCH-MIT.txt`](licenses/BOOTSTRAP-BOOTSWATCH-MIT.txt).

- [Bootstrap](https://github.com/twbs/bootstrap), copyright the Bootstrap Authors
  and Twitter, Inc.
- [Bootswatch](https://github.com/thomaspark/bootswatch), copyright Thomas Park
- The Exor theme retains its copyright notice for Joe Uhren.

The explorer bundles [Font Awesome Free 6.7.2](https://fontawesome.com/) under
`public/vendor/fontawesome/` so that navigation and status icons remain
available without a third-party browser request. Font Awesome Free is provided
under the CC BY 4.0, SIL OFL 1.1 and MIT licenses, as applicable to its icons,
fonts and code. The upstream `@fortawesome/fontawesome-free@6.7.2` package was
verified against registry integrity
`sha512-JUOtgFW6k9u4Y+xeIaEiLr3+cjoUPiAuLXoyKOJSia6Duzb7pq+A76P9ZdPDoAoxHdHzq6gE9/jKBGXlZT8FbA==`.
The complete upstream license notice is retained in
[`licenses/FONTAWESOME-FREE-6.7.2.txt`](licenses/FONTAWESOME-FREE-6.7.2.txt).

Runtime and development packages are installed from the exact versions and
integrities recorded in `package-lock.json`. Their package metadata and license
files are installed by `npm ci`; those packages remain under their respective
licenses. Other browser libraries loaded from their publishers' CDNs remain
under their respective upstream licenses and are not relicensed by this
repository.

The optional peer-country enrichment calls the external
[country.is](https://country.is/) HTTPS API by default. No country.is code or data
is bundled or redistributed. Operators can disable the call or configure a
self-hosted compatible endpoint; peer collection continues without it.

## Nito Network brand asset

The mainnet explorer images `public/img/logo.png`,
`public/img/header-logo.png`, `public/img/page-title-img.png` and the
`public/favicon-*.png` family use the official transparent Nito Network artwork
distributed by Nito Core. The 32, 48, 64 and 128 pixel files are byte-identical
to their Core counterparts. The 180 and 192 pixel favicons are
alpha-preserving, high-quality size derivatives of the official 1024 pixel
source for browser metadata.

`public/img/nito-testnet-page-title-green.png` is the Nito Network testnet brand
image selected for this explorer and sourced from the Nito Network testnet
explorer at
`https://testnet-explorer.nito.tools/img/page-title-green.png`. Copyright and
brand rights remain with Nito Network. It is a project
branding asset, not third-party application code, and the repository's BSD
license does not grant rights to use the Nito name or marks for an unrelated
product.

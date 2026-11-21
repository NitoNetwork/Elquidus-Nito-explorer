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

Runtime and development packages are installed from the exact versions and
integrities recorded in `package-lock.json`. Their package metadata and license
files are installed by `npm ci`; those packages remain under their respective
licenses. Browser libraries loaded from their publishers' CDNs remain under their
respective upstream licenses and are not relicensed by this repository.

The optional peer-country enrichment calls the external
[country.is](https://country.is/) HTTPS API by default. No country.is code or data
is bundled or redistributed. Operators can disable the call or configure a
self-hosted compatible endpoint; peer collection continues without it.

## Nito Network brand asset

`public/img/nito-testnet-page-title-green.png` is the Nito Network testnet brand
image selected for this explorer and sourced from the Nito Network testnet
explorer at
`https://testnet-explorer.nito.tools/img/page-title-green.png`. Copyright and
brand rights remain with Nito Network. It is a project
branding asset, not third-party application code, and the repository's BSD
license does not grant rights to use the Nito name or marks for an unrelated
product.

# Pinned protocol package

Gen2Prod normally installs the immutable `@website-ontology/contracts` tarball
recorded in `contracts-release.json`. This keeps the SiteSpec/Gen2Prod repository
boundary real and makes a clean CI checkout independent of a Flywheel filesystem
path.

During an explicitly coordinated local protocol change only, an operator may use
a temporary package-manager override pointing at the WebsiteOntology contracts
workspace. That override must not be committed. Before updating the pin, build
and test WebsiteOntology, create a package tarball with `pnpm pack`, update the
version, digest, and source commit, reinstall, run `bun run verify`, and commit
the release artifact separately from unrelated Gen2Prod changes.

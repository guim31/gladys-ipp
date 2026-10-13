# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. Earlier versions
are described in the [GitHub Releases](https://github.com/guim31/gladys-ipp/releases).

## [Unreleased]

### Changed

- Quieter logs: at the default level they now show the start, the discoveries,
  each printer that stops answering and comes back (once each, not every
  15 seconds) and your actions. Start the container with `LOG_LEVEL=debug` to
  see every reading and every retry.
- Built on version 0.15 of the Gladys integration SDK; dependencies updated.

### Fixed

- Printers keep being read even when Gladys does not poll them (Gladys 5.2.0
  skips devices created without polling enabled): the integration reads every
  added printer itself, and a poll from Gladys right after one of its own
  readings no longer queries the printer a second time.
- Printers found on the network now use the IPP path they announce over mDNS
  (`rp`), instead of always `/ipp/print`: a printer listening elsewhere is
  found without typing its full address.

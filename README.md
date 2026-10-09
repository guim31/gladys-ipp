# Gladys IPP Printers integration

External integration for [Gladys Assistant](https://gladysassistant.com) that
monitors **network printers over IPP** (Internet Printing Protocol, the
AirPrint protocol): ink/toner levels and printer state, fully local — no
account, no cloud, no dependency beyond the official
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

Built from the official
[integration-template-js](https://github.com/GladysAssistant/integration-template-js).

## What it does

- **Automatic discovery**: printers advertising `_ipp._tcp` over mDNS are
  found through the Gladys mediated network discovery (the core captures the
  LAN traffic the sandboxed container cannot see), then joined in unicast.
- **Manual list**: IPs, hostnames or `ipp://` URIs typed in the
  configuration, for printers mDNS cannot reach.
- **One device per printer**, with one `LEVEL_SENSOR` feature (0-100 %) per
  ink/toner supply and a `TEXT` feature carrying the printer state (`idle`,
  `printing`, `stopped (media-empty)`, …).
- **Three supply sources**, tried in that order, because firmwares disagree
  on where levels live: the `marker-*` IPP attributes, the `printer-supply`
  pair of PWG 5100.13, and — when IPP announces nothing at all — the
  Printer MIB over SNMP (RFC 3805, what CUPS reads).
- **SNMP complement for printer parts**: lasers often announce only their
  toners over IPP, while the Printer MIB also lists the drum/imaging unit,
  fuser, transfer belt and waste container. Those parts are appended after
  the IPP supplies — never a cartridge, never a part IPP already announces
  (same type, same part by name, or same key), and the IPP features keep
  their keys. The SNMP query is a unicast to the printer the integration is
  already talking to, sent only when the levels are due; a printer that does
  not answer is left alone for 30 minutes, one that answers with nothing to
  add for 6 hours. The _Test a printer_ action tells where each level comes
  from (`(via SNMP)`, `(+ SNMP: Imaging Unit)`).
- **Polling** at a configurable interval; the working IPP URL is stored in
  the device params, so polling survives restarts without a re-discovery.
- **Test a printer** action: probe any host from the Configuration screen and
  see the model, state and levels it answers.
- **Two dashboard widgets** (Gladys ≥ 5.1): _Printer_ — one printer with a
  live gauge per supply (bound to the level features), its state, the time of
  the last reading, the lowest supply and a _Check_ button that polls it now;
  _Supplies_ — every printer in one list, the most critical first, with the
  number of printers to watch. Both render from the last poll kept in memory:
  a widget never sends an IPP or SNMP request.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no protocol logic)
├─ src/
│  ├─ ipp/
│  │  ├─ constants.js                # IPP tags, operations, printer states
│  │  ├─ message.js                  # binary IPP encoding/decoding (RFC 8010), pure functions
│  │  └─ client.js                   # HTTP transport, candidate URLs, probing
│  ├─ snmp/
│  │  ├─ ber.js                      # the ASN.1 BER slice SNMP needs, pure functions
│  │  ├─ client.js                   # SNMPv1 GetNext walk over UDP 161
│  │  └─ supplies.js                 # Printer MIB (RFC 3805) -> supply rows
│  ├─ printer.js                     # raw IPP attributes -> printer model (markers, state)
│  ├─ supplies.js                    # SNMP fallback + parts complement
│  ├─ device.js                      # printer model -> Gladys device + states, polling, snapshots
│  ├─ widgets.js                     # dashboard widget contents (pure builders)
│  ├─ discovery.js                   # manual list + mDNS -> probed printers
│  ├─ actions.js                     # manifest action handlers (test_printer)
│  ├─ naming.js                      # feature names and short supply names (fr/en/raw)
│  └─ config.js                      # config defaults + normalization
├─ docs/                             # user documentation (fr/en), re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (name, config schema, mDNS capture, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ test/                             # node --test unit tests (no framework)
```

The IPP client is ~200 lines of dependency-free Node: IPP is a binary TLV
message POSTed over HTTP (`application/ipp`, port 631). The integration sends
a single operation, `Get-Printer-Attributes`, and reads the standard
`marker-names` / `marker-levels` / `printer-state` attributes.

The SNMP client is the same idea for the fallback and the complement: BER is another TLV format,
and one `GetNextRequest` walk over `prtMarkerSupplies` is all the Printer MIB
needs — no dependency either. Both are tested against real local servers
(HTTP, HTTPS and UDP), not mocks.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="ipp-printers" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. The SDK reads them
automatically.

## Quality checks

```bash
npm run format:check   # Prettier: is everything formatted?
npm run lint           # ESLint: catch real mistakes
npm test               # Unit tests, via the built-in `node --test` runner
```

The same three checks run in CI on every push and pull request.

## Publishing

The repo follows the template's release flow: **Actions → Release → Run
workflow** bumps the version everywhere (`package.json` + manifest
`version`/`docker_image`), pushes the `vX.Y.Z` tag and builds the
multi-arch image (`linux/amd64` + `linux/arm64`) to `ghcr.io`. Adding the
GitHub topic `gladys-assistant-integration` makes the decentralized store
indexer pick it up.

Validate locally before tagging:

```bash
npx github:GladysAssistant/integration-store .
```

## License

Apache-2.0

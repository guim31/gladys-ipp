# IPP Printers

This integration monitors your network printers through the standard **IPP**
protocol (Internet Printing Protocol) — the one AirPrint uses. It runs fully
locally: no account, no cloud, no API key.

## What you get

One Gladys device per printer, with:

- **one sensor per ink or toner cartridge** (level in %), with history — so
  you can chart consumption over time and trigger scenes ("black ink below
  10% → notification");
- **the printer state**: `idle` (ready), `printing`, `stopped`, with the
  reason when the printer reports it (`stopped (media-empty)` = out of
  paper). The state is watched **continuously** (sampled every 15 s) and updated as
  soon as it changes, independently of the interval set for the levels: a
  print job only lasts a few seconds.

> A printer permanently showing `idle` is usually normal: that is the state
> of a powered-on printer with nothing to do. It only changes while printing
> or when something is wrong (out of paper, jam). The "Test a printer" button
> shows you live what yours reports at any moment.

## Compatibility

Any network printer supporting **AirPrint / IPP Everywhere** (the vast
majority of printers sold since ~2012: HP, Epson, Canon, Brother, Lexmark…).
The printer must be on the same network as Gladys, with IPP enabled (it is by
default; some menus call it "AirPrint").

Some printers do not advertise their ink levels over IPP: in that case the
device only exposes its state.

## Configuration

1. Install the integration: printers advertising IPP over mDNS are discovered
   automatically and show up in the **Discovery** tab.
2. If a printer is not found (mDNS blocked, different subnet…), add it to
   **Printers (manual list)**: an IP (`192.168.1.20`), a hostname
   (`printer.local`) or a full URI (`ipp://192.168.1.20/ipp/print`),
   separated by commas.
3. Adjust the **refresh interval** if needed (900 s by default — ink levels
   move slowly). It only applies to the levels: the state is watched
   continuously (every 15 s).
4. Pick the language of the **sensor names** if you wish: by default they are
   the raw names reported by the printer (usually English, like "black
   cartridge"); selecting French turns the recognized cartridges into
   « Encre noire », « Toner cyan »… The setting applies to **newly added**
   devices — for an existing device, rename its features from its page, or
   delete and re-add it (the history of the old features is then lost).
5. Add the discovered devices from the **Discovery** tab.

> Tip: give a fixed IP (DHCP reservation) to printers that do not advertise
> their unique id (UUID) — the integration then falls back to the hostname to
> identify them.

## Actions

- **Test a printer** — type an IP, hostname or `ipp://` URI: the integration
  queries it live and shows the model, state and detected levels. The fastest
  way to check an address before adding it to the manual list.

## Troubleshooting

- **Printer not discovered**: check that it answers IPP with the "Test a
  printer" action. If the test fails, check that port 631 is open and that
  IPP/AirPrint is enabled in the printer settings.
- **No ink levels**: the printer does not publish the `marker-levels`
  attributes over IPP. That is a firmware limitation, not an integration
  one.
- **A single cartridge shows "unknown" (often the black one, on HP)**: if
  that cartridge is refilled or third-party, this is by HP design — the
  firmware refuses to estimate the level of non-genuine cartridges (it shows
  "?" even on the printer's own screen). The value exists nowhere; with a
  genuine cartridge the level comes back by itself. The "Test a printer"
  button shows the raw reported value ("unknown (-2)").
- **Non-standard IPP path**: by default the integration tries `/ipp/print`,
  `/ipp` then `/`. If your printer uses another path (some CUPS queues for
  instance), type the full URI: `ipp://host:631/the/path`.
- The integration logs (Gladys UI or `docker logs`, with `LOG_LEVEL=debug`
  for full detail) trace every request and every skipped printer.

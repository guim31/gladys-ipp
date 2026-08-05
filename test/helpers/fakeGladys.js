// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the integration modules rely on:
//   - externalIds(type, platformId)  -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishDiscoveredDevices       -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
//   - scanNetwork                    -> resolve the entries injected by the test
// This lets us test the pure "wiring" logic (discovery payloads, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys({ mdnsEntries = [] } = {}) {
  const published = [];
  const discoveredDevices = [];
  const connectionStatuses = [];
  const scans = [];

  return {
    published,
    discoveredDevices,
    connectionStatuses,
    scans,

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({
          featureExternalId: s.device_feature_external_id,
          state: s.state ?? s.text,
        });
      }
    },

    async publishDiscoveredDevices(devices) {
      discoveredDevices.push(...devices);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async scanNetwork(type, options) {
      scans.push({ type, options });
      if (mdnsEntries instanceof Error) {
        throw mdnsEntries;
      }
      return mdnsEntries;
    },
  };
}

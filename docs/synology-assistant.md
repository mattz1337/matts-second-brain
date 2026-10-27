# Assistant and Garmin on Synology

This extends the [base DS423+ deployment](synology.md). Keep LAN/VPN access and the existing HTTPS owner login. The assistant works without Garmin: deploy an image containing this code, then configure OpenRouter in Settings. Cloud AI stays off until selected in a conversation.

The optional Garmin companion requires the existing Garmin stack on the same Docker host. Orbit reuses its chat image and read-only volumes; no collectors or raw databases are moved.

## Prepare the companion project

1. Back up Orbit using the existing stopped-data backup procedure. Choose an **assistant-enabled** image and pin its digest. The previous `ghcr.io/mattz1337/orbit:0.2.0` image predates this feature; use the successful CI image from the commit containing it or a later tested release. This implementation does not publish an image or change the NAS automatically.
2. Inspect the existing Garmin chat container in Container Manager. Note its container name, image, data network and Influx service hostname. The image must contain the existing `app.chat.data` API and the container must mount its readable `/state/auth.json` and data volumes. Preserve that container and stack.
3. Copy [the companion Compose template](../deploy/compose.assistant.synology.yml) into the Orbit project directory as its single `compose.synology.yml`. Retain your existing `.env`, data and owner-password mount. Copy [the bridge script](../connectors/garmin_bridge.py) beside it as `garmin_bridge.py`.
4. Create a separate random connector token file in the existing private secrets directory. On the NAS, set your actual UID/GID first:

   ```sh
   APP_UID=1026
   APP_GID=100
   sudo mkdir -p /volume1/docker/orbit/secrets
   sudo sh -c 'umask 077; token=$(openssl rand -hex 32); printf "{\"token\":\"%s\"}\n" "$token" > /volume1/docker/orbit/secrets/garmin-bridge.json'
   sudo chown "$APP_UID:$APP_GID" /volume1/docker/orbit/secrets/garmin-bridge.json
   sudo chmod 640 /volume1/docker/orbit/secrets/garmin-bridge.json
   ```

   Keep the parent secrets directory private to the deployment owner. Orbit reads this file as APP_UID; the bridge gets APP_GID as a supplementary group. Do not put the token in source control or paste it into chat.

5. Add these non-secret settings to the existing project `.env`, substituting the inspected values:

   ```dotenv
   ORBIT_IMAGE=ghcr.io/mattz1337/orbit@sha256:YOUR_ASSISTANT_ENABLED_DIGEST
   GARMIN_CHAT_IMAGE=your-existing-garmin-chat-image
   GARMIN_CHAT_CONTAINER=garmin-graphify-chat-1
   GARMIN_NETWORK=garmin-graphify_default
   GARMIN_INFLUX_URL=http://influxdb:8086
   GARMIN_BRIDGE_SCRIPT_PATH=/volume1/docker/orbit/garmin_bridge.py
   GARMIN_BRIDGE_TOKEN_PATH=/volume1/docker/orbit/secrets/garmin-bridge.json
   ```

6. Validate the Compose file with the same Compose CLI used by the base guide, then apply the project through Container Manager or that CLI. Only one Orbit container may own the data directory. Use the base manual updater for subsequent image changes and backups; it expects the project to use one Compose file. Do not run the base project and this replacement simultaneously.
7. Check that Orbit is healthy and the new bridge is healthy. The bridge has no published NAS port; Orbit connects to `http://garmin-bridge:8082` on the internal network. Existing Garmin/Grafana services remain separate.
8. Open Orbit → Settings → Assistant & Garmin. Confirm the internal Garmin URL, configure OpenRouter if desired, and save. Select Garmin in Assistant and try a local question with Cloud AI off. Then enable Cloud AI deliberately for a cited comparison.

The bridge's 384 MB limit and Orbit's 2 GB limit are initial bounds, not measured capacity guarantees for a DS423+ with 6 GB RAM and the rest of the Garmin stack. Watch Container Manager memory and logs during the first queries. Semantic Graphify extraction remains an optional external operation, not a background NAS workload.

## Updates and troubleshooting

- Orbit updates follow the existing image-pull/manual-updater flow. Bridge script changes require copying the new script and recreating the bridge container; the current Orbit image does not package or publish a separate Garmin image.
- If Garmin is unavailable, check bridge logs, the existing Garmin container/volumes, its read-only credential and the shared network. Health checks confirm the HTTP process; the first real query also verifies data access.
- If token reads fail, verify file ownership/group permissions for APP_UID and APP_GID. Do not broaden the whole secrets directory to world-readable.
- If a hosted request has no eligible provider, choose a tool-capable model meeting the documented routing/price requirements. Routing restrictions are not silently relaxed.
- OpenRouter keys are configured server-side through the authenticated Settings UI or environment. Portable backups do not carry those keys; configure them again after migration.
- To stop using the companion, stop/recreate only the Orbit project with the base Compose file and remove the Garmin URL in assistant settings. Keep the data directory and existing Garmin stack.

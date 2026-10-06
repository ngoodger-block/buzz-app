# Builderlab

The bundled `block.builderlab` plugin adds Settings → Integrations → Builderlab.

- `oauth/` owns browser handoff, code exchange, account verification, and the
  plugin-lifetime session. `browserCredential()` returns a verified `Credential`;
  `session.credential()` provides access to it. The session handles cancellation,
  sign-out, and disposal.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login. Requests
  reuse the OAuth credential through native host HTTP; sign-out and navigation
  discard late results. Listing does not enroll agents into Buzz communities.
  Creation registers a name, then attests its key using the host's existing
  owner authorization. An unattested row offers **Finish setup**; no second
  registration is needed. Pending registration UUIDs survive restart and are
  scoped to server, verified account and name. Retry the same name after an
  uncertain failure within the server's seven-day replay window. Credentials
  and owner proofs are never stored. Creation does not add channel membership
  or make the agent selectable in Buzz conversations.
- `known-communities/` keeps the account's community list in step with this
  device through the `knownCommunities` capability while signed in, in native
  builds with a configured service: it checks that the account is bound to this
  device's key (never binding it), merges the service's complete list, uploads
  queued joins and leaves one destination head at a time with retries under the
  same operation ID, and reports its state for the rail's not-synced indicator.
  See [communities](../../../docs/communities.md#known-communities).

The plugin uses the `BUZZ_BUILDERLAB_URL` [build input](../../../docs/configuration.md#builderlab-url-build-input)
as its server address and appends `/api/goose`.

On desktop, the plugin supplies `/v1/auth/login` with `type=cli` and
`product=builderlab` to the shared native
[`oauth_callback` module](../../../src-tauri/src/oauth_callback/README.md).
Native code inserts a loopback `returnTo` address, opens the browser, and returns
callback parameters to the plugin. Builderlab explicitly disables native OAuth
state for its custom protocol and uses a random callback path.

The plugin posts the callback code to `/v1/auth/login/exchange`, then verifies
the returned session credential with `/v1/auth/me` using the
`X-BB-Session-Credential` header. These requests use the shared host transport.

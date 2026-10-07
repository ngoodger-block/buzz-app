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
  discard late results. Existing catalog agents are not automatically registered
  into Buzz communities.
  Creation registers a name, then attests its key using the host's existing
  owner authorization. When a community is selected, attestation includes its
  WebSocket URL to enroll with Beekeeper; Personal space omits it. An unattested
  row offers **Finish setup**; no second registration is needed. Pending
  registration UUIDs survive restart and are scoped to server, verified account
  and name. Retry the same name after an
  uncertain failure within the server's seven-day replay window. Credentials
  and owner proofs are never stored.
  With a connected community selected, activation is followed by owner-signed
  kind-30177 registration through the session's durable outbox. Completion waits
  for relay acceptance and shared agent discovery. Names use the existing shared
  naming service; picker, archive and membership policies remain in their owners.
  Pending enrollment intent is scoped to server, account, community and Buzz
  identity. Opening Settings after reconnect/restart resumes intended Active
  creations; **Retry community setup** reuses a pending publication without
  registering or attesting again. Personal space skips relay registration.
  Creation never adds channel membership.
  **Delete agent** confirms owner-signed kind-5 deletion of the selected
  community's registration, refreshes discovery, then deletes the runtime through
  Beekeeper. Personal space only deletes from Beekeeper. Failure leaves the row
  available for manual retry; an already-missing Beekeeper agent counts as success.
  Account-scoped deletion tombstones (`buzz.builderlab.deletion.v1:`) persist to
  prevent stale enrollment from re-registering deleted keys after restart or in
  another community. They contain only server/account scope and agent pubkey.
  Deletion does not archive identities, remove channel memberships, erase history,
  or clean registrations in other communities.

The plugin uses the `BUZZ_BUILDERLAB_URL` [build input](../../../docs/configuration.md#builderlab-url-build-input)
as its server address and appends `/api/goose`.

On desktop, the plugin supplies `/v1/auth/login` with `type=cli` and
`product=builderlab` to the shared native
[`oauth_callback` module](../../../src-tauri/src/oauth_callback/README.md).
Native code inserts a loopback `redirect_uri` address, opens the browser, and returns
callback parameters to the plugin. Native code generates and validates OAuth
state; the plugin also uses a random callback path.

The plugin posts the callback code to `/v1/auth/login/exchange`, then verifies
the returned session credential with `/v1/auth/me` using the
`X-BB-Session-Credential` header. These requests use the shared host transport.

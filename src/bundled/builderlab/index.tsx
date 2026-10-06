import type { PluginModule } from "../../plugins/api";
import { Login } from "./login/Login";
import {
  browserCredential,
  browserLoginAvailable,
  oauthTarget,
} from "./oauth/browser";
import { createOAuthSession } from "./oauth/session";
import { createAgentClient } from "./agents/client";
import { RemoteAgents } from "./agents/RemoteAgents";
import { createKnownCommunitiesClient } from "./known-communities/client";
import { startKnownCommunitiesSync } from "./known-communities/sync";

export const inject = ["host", "settingsCards", "knownCommunities"];
export const apply: PluginModule["apply"] = (ctx) => {
  let unavailable = "";
  try {
    oauthTarget();
  } catch (error) {
    unavailable =
      error instanceof Error
        ? error.message
        : "Builderlab sign-in is unavailable.";
  }
  const session = createOAuthSession((signal) =>
    browserCredential(ctx.host, signal),
  );
  ctx.effect(() => () => session.dispose());
  // The account's community list follows this sign-in; see docs/communities.md.
  ctx.effect(() =>
    startKnownCommunitiesSync({
      client: createKnownCommunitiesClient(ctx.host, session),
      session,
      knownCommunities: ctx.knownCommunities,
    }),
  );
  const agents = createAgentClient(ctx.host, session);
  ctx.settingsCards.register({
    id: "login",
    title: "Builderlab",
    group: "Integrations",
    component: ({ active }) => (
      <>
        <Login
          session={session}
          available={browserLoginAvailable() && !unavailable}
          unavailableReason={
            browserLoginAvailable()
              ? unavailable
              : "Open the Buzz desktop app to sign in with Builderlab."
          }
          active={active}
        />
        <RemoteAgents client={agents} session={session} active={active} />
      </>
    ),
  });
};

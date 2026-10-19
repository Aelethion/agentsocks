import type { SweepStage } from "../sweep/types.ts";
import { pruneProxies } from "./federation.ts";
import { OAuthStore } from "./oauth.ts";
import { notifyAppPeers } from "./push.ts";
import { gatewayOf } from "./runtime.ts";

export const gatewayStages: readonly SweepStage[] = [
  { name: "gateway", run: (broker) => gatewayOf(broker).reconcile() },
  { name: "gateway push", run: (broker, now) => notifyAppPeers(broker, now) },
  {
    name: "gateway cleanup",
    run: (broker, now) => {
      new OAuthStore(broker.store.db).sweep(now);
      new OAuthStore(broker.store.db).pruneIdleClients(now);
      pruneProxies(broker, now);
    },
  },
];

import { appRoutes } from "./app/api.ts";
import { federationRoutes } from "./federation.ts";
import { mcpRoutes } from "./mcp.ts";
import { oauthRoutes } from "./oauth.ts";
import { routes } from "./routes.ts";

export const ROUTES = routes(mcpRoutes, appRoutes, federationRoutes, oauthRoutes);

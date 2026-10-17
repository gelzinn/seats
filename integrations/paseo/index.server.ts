import type { PluginServerContext } from "@getpaseo/plugin/server";
import { seatEnvForProvider } from "./server/seat-env";

export default function contribute(server: PluginServerContext) {
  return server.before("agent.session_open", ({ request }) => {
    const env = seatEnvForProvider(request.provider);
    if (!env) return undefined;
    console.log(`[seats] ${request.reason} ${request.provider}: ${Object.values(env).join(", ")}`);
    return { ...request, env: { ...request.env, ...env } };
  });
}

/** Entry for any host that runs a process: `deno run -A entry/serve.ts`. */
import { buildApp } from "../core/app.ts";
import { compose } from "../compose.ts";
import { EnvSettings } from "../adapters/settings.ts";
import { ConsoleLog } from "../adapters/log.ts";

const settings = new EnvSettings();
const log = new ConsoleLog();
const { ports, options } = await compose(settings, log);
const app = buildApp(ports, options);
Deno.serve({ port: Number(settings.get("PORT") ?? "8000") }, app.fetch);

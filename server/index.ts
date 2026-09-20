/**
 * Entry for Supabase Edge Functions. Upstream's deploy command still targets
 * this file. The only runtime coupling to Supabase in the codebase is the
 * type import on the next line.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { buildApp } from "./core/app.ts";
import { compose } from "./compose.ts";
import { EnvSettings } from "./adapters/settings.ts";
import { ConsoleLog } from "./adapters/log.ts";

const { ports, options } = await compose(new EnvSettings(), new ConsoleLog());
Deno.serve(buildApp(ports, options).fetch);

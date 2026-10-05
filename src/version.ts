import { readFileSync } from "node:fs";

/** Read from package.json so a release changes cache identity without a second place to bump. */
export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

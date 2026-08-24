#!/usr/bin/env node
import { createProgram } from "./program.js";

createProgram().parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`skillcaller: ${(error as Error).message}\n`);
  process.exitCode = 1;
});

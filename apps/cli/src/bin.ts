#!/usr/bin/env node
import { main } from "./cli.js";
import { processIo } from "./io.js";

const code = await main(process.argv.slice(2), processIo());
// Pending handles (a terminal on stdin, pooled connections) must not keep the process alive.
process.exit(code);

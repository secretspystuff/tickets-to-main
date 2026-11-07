#!/usr/bin/env node
import { defaultIo, run } from "../src/cli.ts";

const code = await run(process.argv.slice(2), defaultIo());
process.exit(code);

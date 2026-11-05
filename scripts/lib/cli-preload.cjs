/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload by design */
// Command-line scripts load the app's own service code. That code is marked "server-only" (it must
// never reach a browser bundle); a terminal is a server, so the guard is satisfied here with an
// empty module. Used as: npx tsx --require ./scripts/lib/cli-preload.cjs scripts/<script>.ts
const Module = require("node:module");
const id = require.resolve("server-only");
const m = new Module(id);
m.filename = id;
m.loaded = true;
m.exports = {};
require.cache[id] = m;

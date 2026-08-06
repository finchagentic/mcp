#!/usr/bin/env node
// Auto-replaces @X.Y.Z version pins in README.md with the current package version before publish.
// Runs as part of prepublishOnly — never commit the modified README, it's ephemeral.

const fs = require("fs");
const path = require("path");

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
const version = pkg.version;

const readmePath = path.join(__dirname, "../README.md");
let readme = fs.readFileSync(readmePath, "utf8");

// Replace all pinned version refs: @finchagentic/mcp@X.Y.Z
const updated = readme.replace(/@finchagentic\/mcp@\d+\.\d+\.\d+/g, `@finchagentic/mcp@${version}`);

fs.writeFileSync(readmePath, updated, "utf8");
console.log(`✔ README.md version pins updated to @finchagentic/mcp@${version}`);

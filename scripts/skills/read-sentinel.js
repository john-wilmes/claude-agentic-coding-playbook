#!/usr/bin/env node
"use strict";
const fs = require("fs");

const flagFile = process.argv[2];
if (!flagFile) {
  process.stdout.write("STAY\n");
  process.exit(0);
}

try {
  const data = JSON.parse(fs.readFileSync(flagFile, "utf8"));
  const ageMs = Date.now() - (data.timestamp || 0);
  if (ageMs < 600000 && (data.ratio || 0) >= 0.5) {
    process.stdout.write("EXIT\n");
  } else {
    process.stdout.write("STAY\n");
  }
} catch {
  process.stdout.write("STAY\n");
}

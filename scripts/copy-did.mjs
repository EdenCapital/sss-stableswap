#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync } from "fs";
const srcIc = ".dfx/ic/canisters/vaultpair/service.did.js";
const srcLocal = ".dfx/local/canisters/vaultpair/service.did.js";
const src = existsSync(srcIc) ? srcIc : srcLocal;
const dst = "canisters/www/src/vaultpair.did.js";

mkdirSync("canisters/www/src", { recursive: true });
copyFileSync(src, dst);
console.log(`[copy-did] ${src} -> ${dst}`);

// canisters/www/src/api/actor.ts
import { HttpAgent, Actor, type Identity } from "@dfinity/agent";
import { idlFactory as idl } from "../vaultpair.did.js";

const CANISTER_ID = (import.meta as any).env?.VITE_VAULTPAIR_ID;
if (!CANISTER_ID) throw new Error("Missing VITE_VAULTPAIR_ID");

// 统一 Host 选择：本地走 dfx，主网优先 icp-api.io（更快更稳）
function resolveHost() {
  const isBrowser = typeof window !== "undefined";
  const loc = isBrowser ? window.location.origin : "";
  const isLocal = /127\.0\.0\.1|localhost/.test(loc);
  if (isLocal) return loc; // 例如 http://127.0.0.1:4943
  return (import.meta as any).env?.VITE_IC_HOST || "https://icp-api.io";
}

export async function createAgent(identity?: Identity) {
  const host = resolveHost();
  const agent = new HttpAgent({ host, identity });
  // 仅本地需要 root key
  if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(host)) {
    await (agent as any).fetchRootKey?.();
  }
  return agent;
}

export async function getVaultpairActor(identity?: Identity) {
  const agent = await createAgent(identity);
  return Actor.createActor(idl as any, { agent, canisterId: CANISTER_ID }) as any;
}

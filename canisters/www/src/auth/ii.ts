import { AuthClient } from "@dfinity/auth-client";

const IDENTITY_PROVIDER =
  (import.meta as any).env?.VITE_II_URL || "https://id.ai"; // II 2.0
const DERIVATION_ORIGIN = (import.meta as any).env?.VITE_II_DERIVATION_ORIGIN; // 可选

let _client: AuthClient | null = null;

export async function getClient(): Promise<AuthClient> {
  if (!_client) _client = await AuthClient.create(); // ← 不要放 derivationOrigin
  return _client;
}

export async function isAuthenticated(): Promise<boolean> {
  const c = await getClient();
  return c.isAuthenticated();
}

export async function getIdentity() {
  const c = await getClient();
  return c.getIdentity();
}

export async function login(): Promise<void> {
  const c = await getClient();
  await new Promise<void>((resolve, reject) => {
    c.login({
      identityProvider: IDENTITY_PROVIDER,
      // ← 把 derivationOrigin 放在 login 里
      ...(DERIVATION_ORIGIN ? { derivationOrigin: DERIVATION_ORIGIN } : {}),
      maxTimeToLive: BigInt(24 * 60 * 60 * 1_000_000_000),
      onSuccess: () => resolve(),
      onError: (e) => reject(e),
    });
  });
}

export async function logout(): Promise<void> {
  const c = await getClient();
  await c.logout();
}

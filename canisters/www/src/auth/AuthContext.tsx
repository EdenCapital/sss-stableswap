import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Identity } from "@dfinity/agent";
//import { checkAuthenticated, getIdentity, login, logout } from "./ii"; // 如果你之前导出了 checkAuthenticated，保留；否则见下行
// 如果没有导出 checkAuthenticated，可用 isAuthenticated 起别名：
import { isAuthenticated as checkAuthenticated, getIdentity, login, logout } from "./ii";

type Ctx = {
  ready: boolean;
  isAuthed: boolean;
  principalText: string | null;
  identity: Identity | null;
  doLogin: () => Promise<void>;
  doLogout: () => Promise<void>;
};

const AuthCtx = createContext<Ctx>({
  ready: false,
  isAuthed: false,
  principalText: null,
  identity: null,
  doLogin: async () => {},
  doLogout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [isAuthed, setIsAuthed] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    (async () => {
      const ok = await checkAuthenticated();
      setIsAuthed(ok);
      if (ok) setIdentity(await getIdentity());
      setReady(true);
    })();
  }, []);

  const principalText = useMemo(
    () => (identity ? identity.getPrincipal().toText() : null),
    [identity]
  );

  const doLogin = async () => {
    await login();
    setIsAuthed(true);
    setIdentity(await getIdentity());
  };

  const doLogout = async () => {
    await logout();
    setIsAuthed(false);
    setIdentity(null);
  };

  return (
    <AuthCtx.Provider
      value={{ ready, isAuthed, principalText, identity, doLogin, doLogout }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}

// 顶部登录徽章：显示截断 principal，悬停提示完整值，点击复制
export function LoginBadge() {
  const { ready, isAuthed, principalText, doLogin, doLogout } = useAuth();
  const truncated =
    principalText ? principalText.slice(0, 4) + "…"+ principalText.slice(-4) : "";

  const copy = async () => {
    if (principalText) {
      await navigator.clipboard.writeText(principalText);
      // 简单提示；可替换成 toast
      alert("已复制 Principal 到剪贴板");
    }
  };

  if (!ready) return <button className="btn" disabled>…</button>;

  return isAuthed ? (
    <div className="login-badge">
      <span title={principalText || ""} onClick={copy} style={{ cursor: "pointer" }}>
        II: {truncated}
      </span>
      <button className="btn" onClick={doLogout} style={{ marginLeft: 8 }}>Logout</button>
    </div>
  ) : (
    <button className="btn" onClick={doLogin}>Login with II</button>
  );
}

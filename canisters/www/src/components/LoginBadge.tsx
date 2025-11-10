import React from "react";
import { useAuth } from "../auth/AuthContext";

function truncate(text: string, keep = 5) {
  if (text.length <= keep * 2 + 3) return text;
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

export const LoginBadge: React.FC = () => {
  const { ready, isAuthed, principalText, doLogin, doLogout } = useAuth();

  if (!ready) {
    return (
      <button
        style={{
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid #999",
          background: "#222",
          color: "#ddd",
          cursor: "wait",
        }}
        disabled
      >
        Initializing…
      </button>
    );
  }

  if (!isAuthed) {
    return (
      <button
        onClick={() => doLogin()}
        style={{
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid #0ea5e9",
          background: "#0ea5e9",
          color: "white",
          fontWeight: 600,
        }}
      >
        Connect Internet Identity
      </button>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "8px 12px",
        borderRadius: 12,
        border: "1px solid #16a34a",
        background: "#052e16",
        color: "#86efac",
        fontWeight: 600,
      }}
      title={principalText ?? ""}
    >
      <span>II:</span>
      <span>{principalText ? truncate(principalText) : "Unknown"}</span>
      <button
        onClick={() => doLogout()}
        style={{
          marginLeft: 10,
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid #444",
          background: "#1f2937",
          color: "#ddd",
          fontWeight: 600,
        }}
      >
        Logout
      </button>
    </div>
  );
};

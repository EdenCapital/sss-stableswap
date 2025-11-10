import React from "react";
import { createBrowserRouter, Link, Outlet } from "react-router-dom";
import Swap from "../pages/Swap";
import Liquidity from "../pages/Liquidity";
import Explore from "../pages/Explore";
import Assets from "../pages/Assets";
import { AuthProvider, LoginBadge } from "../auth/AuthContext";

function Shell() {
  return (
    <AuthProvider>
      <div className="container">
        <div className="topbar">
          <h2>SSS • StableSwap Demo</h2>
          <LoginBadge />
        </div>
        <nav className="nav">
          <Link to="/swap">Swap</Link>
          <Link to="/liquidity">Liquidity</Link>
          <Link to="/explore">Explore</Link>
          <Link to="/assets">Assets</Link>
        </nav>
        <Outlet />
      </div>
    </AuthProvider>
  );
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Swap /> }, 
      { path: "/swap", element: <Swap /> },
      { path: "/liquidity", element: <Liquidity /> },
      { path: "/explore", element: <Explore /> },
      { path: "/assets", element: <Assets /> },
      // 可选：默认重定向到 /swap
      // { index: true, element: <Navigate to="/swap" replace /> },
    ],
  },
]);

export default router;

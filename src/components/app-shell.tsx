"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import type { Role } from "@prisma/client";

type Branch = { id: string; name: string; code: string };
type NavItem = { href: string; label: string; icon: string; roles: Role[]; warehouseOnly?: boolean };
const groups: { heading: string; links: NavItem[] }[] = [
  { heading: "Operations", links: [
    { href: "/pos", label: "Point of sale", icon: "▣", roles: ["OWNER", "MANAGER", "CASHIER"] },
    { href: "/requests", label: "Stock requests", icon: "↗", roles: ["OWNER", "MANAGER", "CASHIER"] },
    { href: "/inventory", label: "Inventory", icon: "◫", roles: ["OWNER", "MANAGER"], warehouseOnly: true },
    { href: "/transfers", label: "Transfers", icon: "⇄", roles: ["OWNER", "MANAGER"], warehouseOnly: true },
  ] },
  { heading: "Manage", links: [
    { href: "/catalog/products", label: "Products", icon: "◇", roles: ["OWNER", "MANAGER"] },
    { href: "/catalog/ingredients", label: "Ingredients", icon: "◈", roles: ["OWNER", "MANAGER"] },
    { href: "/purchasing/suppliers", label: "Suppliers", icon: "⌂", roles: ["OWNER", "MANAGER"] },
    { href: "/purchasing/orders", label: "Purchase orders", icon: "▤", roles: ["OWNER", "MANAGER"] },
  ] },
  { heading: "Insights", links: [
    { href: "/reports", label: "Reports", icon: "▥", roles: ["OWNER", "MANAGER"] },
  ] },
  { heading: "Settings", links: [
    { href: "/admin/branches", label: "Branches", icon: "⌂", roles: ["OWNER"] },
    { href: "/admin/users", label: "Team", icon: "◯", roles: ["OWNER"] },
    { href: "/admin/qr-menu", label: "QR menu", icon: "▦", roles: ["OWNER", "MANAGER"] },
    { href: "/admin/activity", label: "Activity", icon: "◷", roles: ["OWNER"] },
  ] },
];

const STORAGE_KEY = "restoflow_sidebar_collapsed";
export function AppShell({ children, user, branches, activeBranchId, isWarehouseAdmin }: {
  children: React.ReactNode;
  user: { name: string; email: string | null; role: Role };
  branches: Branch[];
  activeBranchId: string | null;
  isWarehouseAdmin: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(STORAGE_KEY) === "1"); } catch { /* optional preference */ }
  }, []);
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const visibleGroups = groups.map(group => ({ ...group, links: group.links.filter(link =>
    link.roles.includes(user.role) && (!link.warehouseOnly || isWarehouseAdmin),
  ) })).filter(group => group.links.length);
  const current = visibleGroups.flatMap(group => group.links).sort((a, b) => b.href.length - a.href.length)
    .find(link => pathname === link.href || pathname.startsWith(link.href + "/"));
  const currentGroup = visibleGroups.find(group => group.links.some(link => link.href === current?.href));
  const branch = branches.find(b => b.id === activeBranchId);
  const initial = user.name.trim().charAt(0).toUpperCase() || "W";

  function toggleCollapsed() {
    setCollapsed(prev => {
      try { localStorage.setItem(STORAGE_KEY, prev ? "0" : "1"); } catch { /* optional preference */ }
      return !prev;
    });
  }
  async function onBranchChange(branchId: string) {
    const response = await fetch("/api/branch", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branchId }),
    });
    if (response.ok) window.location.reload();
  }

  return <div className={`app-frame ${collapsed ? "app-frame--collapsed" : ""}`}>
    <a href="#main-content" className="skip-link">Skip to content</a>
    {mobileOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <aside className={`app-sidebar ${mobileOpen ? "app-sidebar--open" : ""}`} aria-label="Main navigation">
      <div className="sidebar-brand">
        <Link href="/pos" className="brand-link" title="We Got Cha! home">
          <span className="brand-mark">W<span>!</span></span>
          <span className="brand-copy"><strong>We Got Cha!</strong><small>OPERATIONS</small></span>
        </Link>
        <button type="button" className="sidebar-collapse" onClick={toggleCollapsed} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={collapsed ? "m9 5 7 7-7 7" : "m15 5-7 7 7 7"}/></svg>
        </button>
        <button type="button" className="sidebar-mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation">×</button>
      </div>
      <nav className="sidebar-nav">
        {visibleGroups.map(group => <div className="nav-group" key={group.heading}>
          <div className="nav-group-heading">{group.heading}</div>
          {group.links.map(link => {
            const active = current?.href === link.href;
            return <Link key={link.href} href={link.href} title={collapsed ? link.label : undefined} aria-current={active ? "page" : undefined} className={`nav-item ${active ? "nav-item--active" : ""}`}>
              <span className="nav-icon" aria-hidden="true">{link.icon}</span><span className="nav-label">{link.label}</span>
            </Link>;
          })}
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-user"><span className="user-avatar">{initial}</span><span className="sidebar-user-copy"><strong>{user.name}</strong><small>{user.role.toLowerCase()}</small></span></div>
        <button type="button" className="sidebar-signout" onClick={() => signOut({ callbackUrl: "/login" })} title="Sign out">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5m4-4 4-4-4-4m4 4H9"/></svg><span>Sign out</span>
        </button>
      </div>
    </aside>
    <div className="app-workspace">
      <header className="app-topbar">
        <div className="topbar-location">
          <button type="button" className="mobile-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation" aria-expanded={mobileOpen}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <span className="topbar-section">{currentGroup?.heading || "Workspace"}</span><span className="topbar-chevron">/</span><strong>{current?.label || "Overview"}</strong>
        </div>
        <div className="topbar-actions">
          <span className="topbar-branch-label">Working at</span>
          <select aria-label="Active branch" value={activeBranchId ?? ""} onChange={e => onBranchChange(e.target.value)} disabled={!branches.length} className="branch-select">
            {branches.map(b => <option key={b.id} value={b.id}>{b.name} ({b.code})</option>)}
          </select>
          <span className="topbar-avatar" title={`${user.name} · ${user.role.toLowerCase()}`}>{initial}</span>
        </div>
      </header>
      <main id="main-content" className="app-main" tabIndex={-1}>
        <div className="mobile-context">{branch?.name || "Workspace"} <span>·</span> {current?.label || "Overview"}</div>
        {children}
      </main>
    </div>
  </div>;
}

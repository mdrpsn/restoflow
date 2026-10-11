"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string };

const groups: { heading: string; tabs: Tab[] }[] = [
  {
    heading: "Sales",
    tabs: [
      { href: "/reports", label: "Overview" },
      { href: "/reports/daily", label: "Daily summary" },
      { href: "/reports/sales", label: "Sales" },
      { href: "/reports/food-cost", label: "Food cost" },
      { href: "/reports/menu-costing", label: "Menu costing" },
    ],
  },
  {
    heading: "Inventory",
    tabs: [
      { href: "/reports/inventory", label: "Inventory" },
      { href: "/reports/consumption", label: "Consumption & variance" },
      { href: "/reports/recipe-health", label: "Recipe health" },
      { href: "/reports/movements", label: "Movements" },
      { href: "/reports/transfers", label: "Transfers" },
    ],
  },
  {
    heading: "Operations",
    tabs: [{ href: "/reports/logins", label: "Staff logins" }],
  },
];

/**
 * Two-tier nav: which group the current page belongs to is highlighted on top,
 * and only that group's own pages show as sub-tabs — instead of nine flat tabs
 * competing for attention regardless of what you're actually looking at.
 */
export function ReportsNav() {
  const pathname = usePathname();
  const activeGroup = groups.find((g) => g.tabs.some((t) => t.href === pathname)) ?? groups[0];

  return (
    <div className="reports-navigation">
      <nav className="reports-groups" aria-label="Report category">
        {groups.map((group) => {
          const active = group.heading === activeGroup.heading;
          return (
            <Link
              key={group.heading}
              href={group.tabs[0].href}
              className={active ? "active" : ""}
              aria-current={active ? "true" : undefined}
            >
              {group.heading}
            </Link>
          );
        })}
      </nav>
      <nav className="reports-pages" aria-label="Report pages">
        {activeGroup.tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={active ? "active" : ""}
              aria-current={active ? "page" : undefined}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { AdminLayout } from "@ajioncorp/skynet/components";
import { Activity, Monitor, ListTodo, Database, FileText, Target, Users } from "lucide-react";

const pages = [
  { href: "/admin/pipeline", label: "Pipeline", icon: Activity },
  { href: "/admin/monitoring", label: "Monitoring", icon: Monitor },
  { href: "/admin/tasks", label: "Tasks", icon: ListTodo },
  { href: "/admin/sync", label: "Sync", icon: Database },
  { href: "/admin/prompts", label: "Prompts", icon: FileText },
  { href: "/admin/workers", label: "Workers", icon: Users },
  { href: "/admin/mission", label: "Mission", icon: Target },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <AdminLayout
      pages={pages}
      currentPath={pathname}
      backHref="/"
      backLabel="Skynet"
      linkComponent={Link}
    >
      {children}
    </AdminLayout>
  );
}

"use client";

import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { AdminLayout } from "@ajioncorp/skynet/components";
import { Activity, Monitor, ListTodo, Database, FileText, Target, Users, ScrollText, ListOrdered, Settings, GitBranch } from "lucide-react";

const pages = [
  { href: "/admin/pipeline", label: "Pipeline", icon: Activity },
  { href: "/admin/monitoring", label: "Monitoring", icon: Monitor },
  { href: "/admin/tasks", label: "Tasks", icon: ListTodo },
  { href: "/admin/sync", label: "Sync", icon: Database },
  { href: "/admin/prompts", label: "Prompts", icon: FileText },
  { href: "/admin/workers", label: "Workers", icon: Users },
  { href: "/admin/project-driver", label: "Project Driver", icon: GitBranch },
  { href: "/admin/logs", label: "Logs", icon: ScrollText },
  { href: "/admin/mission", label: "Mission", icon: Target },
  { href: "/admin/events", label: "Events", icon: ListOrdered },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <AdminLayout
      pages={pages}
      currentPath={pathname}
      backHref="/"
      backLabel="Skynet"
      linkComponent={Link}
      onNavigate={(href) => router.push(href)}
    >
      {children}
    </AdminLayout>
  );
}

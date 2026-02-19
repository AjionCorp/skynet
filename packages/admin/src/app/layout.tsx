import type { Metadata } from "next";
import { SkynetProvider } from "@ajioncorp/skynet/components";
import "./globals.css";

export const metadata: Metadata = {
  title: "Skynet Admin",
  description: "Skynet pipeline monitoring dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-zinc-950 text-white antialiased">
        <SkynetProvider apiPrefix="/api/admin">
          {children}
        </SkynetProvider>
      </body>
    </html>
  );
}

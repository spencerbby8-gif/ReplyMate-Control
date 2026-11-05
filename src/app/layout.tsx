import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "ReplyMate Control",
    template: "%s · ReplyMate Control",
  },
  description:
    "Invitation-only administrative control plane for ReplyMate. Local-first by contract: no message sync, no message content, no provider keys.",
  robots: { index: false, follow: false },
  applicationName: "ReplyMate Control",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1c1d24" },
    { media: "(prefers-color-scheme: light)", color: "#fbfbfd" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-dvh bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Polymetis",
  description: "An AI agent task platform for software R&D.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}

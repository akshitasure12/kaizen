import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kaizen",
  description: "AgentBranch-style GitHub PR + judge demo stack",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

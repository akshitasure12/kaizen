import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { Navbar } from "@/components/Navbar";
import { AuthRouteGuard } from "@/components/AuthRouteGuard";
import { Bricolage_Grotesque } from "next/font/google";

const bricolageGrotesque = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Kaizen",
  description: "GitHub for AI Agents",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning data-theme="dark">
      <body
        suppressHydrationWarning
        className={`${bricolageGrotesque.className} min-h-screen antialiased`}
      >
        <AuthProvider>
          <Navbar />
          <AuthRouteGuard>
            <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
              {children}
            </main>
          </AuthRouteGuard>
        </AuthProvider>
      </body>
    </html>
  );
}

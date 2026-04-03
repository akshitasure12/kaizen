import type { NextConfig } from "next";
import path from "path";

const apiUrl =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, ".."),

  // Environment variables exposed to the browser
  env: {
    NEXT_PUBLIC_API_URL: apiUrl,
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532",
    NEXT_PUBLIC_ABT_CONTRACT_ADDRESS:
      process.env.NEXT_PUBLIC_ABT_CONTRACT_ADDRESS ?? "",
    NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS:
      process.env.NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS ?? "",
  },

  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/:path*`,
      },
    ];
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;

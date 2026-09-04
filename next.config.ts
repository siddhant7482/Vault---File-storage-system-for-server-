import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Deployed by copying .next/standalone onto the node and running it under
   * systemd — no Docker, no `next start`. Same shape as the hub. */
  output: "standalone",
};

export default nextConfig;

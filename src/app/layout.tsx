import type { Metadata, Viewport } from "next";
import { Azeret_Mono, Saira, Saira_Condensed } from "next/font/google";
import "./globals.css";

/* Self-hosted through next/font rather than a <link> to Google. The node
 * is behind Tailscale and will sometimes have no route to the open
 * internet at all; a panel whose type does not load is a panel that
 * looks broken for a reason that has nothing to do with it. */
const sairaCond = Saira_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cond",
  display: "swap",
});

const saira = Saira({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-ui",
  display: "swap",
});

const azeret = Azeret_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Vault",
  description: "File store for CommandHQ.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /* The panel is dark and paints its own ground; telling the browser
   * that stops a white flash on load and colours the phone chrome. */
  themeColor: "#080A0C",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sairaCond.variable} ${saira.variable} ${azeret.variable}`}>
      <body>{children}</body>
    </html>
  );
}

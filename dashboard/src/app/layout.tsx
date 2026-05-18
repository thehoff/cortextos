import type { Metadata, Viewport } from "next";
import { Sora, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const sora = Sora({
  subsets: ["latin"],
  variable: "--font-sora",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "cortextOS Dashboard",
  description: "cortextOS agent orchestration dashboard",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "cortextOS",
  },
  // PWA manifest is auto-discovered from app/manifest.ts.
  // Icons are auto-discovered from app/icon.svg.
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // themeColor controls the browser address-bar color on mobile + the PWA
  // splash bg. Light/dark variants match the gold palette in globals.css.
  // Per-org / white-label overrides will replace these once #9 + #10 land.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#B8860B" },
    { media: "(prefers-color-scheme: dark)", color: "#D4AF37" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <SessionProvider>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
            <TooltipProvider>
              {children}
            </TooltipProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}

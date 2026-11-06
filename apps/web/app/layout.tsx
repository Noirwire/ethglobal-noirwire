import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import { Header } from "@/components/Header";
import { LiveProvider } from "@/components/LiveProvider";
import { buildPublicView } from "@/lib/server/view";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "NoirWire status",
  description: "Live exposure, money movement and NAV proof for the NoirWire market maker.",
};

export const viewport: Viewport = {
  themeColor: "#0b0b0c",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initial = await buildPublicView();
  return (
    <html lang="en" className={`${figtree.variable} h-full antialiased`}>
      <body className="bg-base text-ink min-h-full">
        <LiveProvider initial={initial}>
          <Header />
          <main className="mx-auto w-full max-w-[1100px] px-5 pb-24 pt-10 md:px-8 md:pt-16">{children}</main>
        </LiveProvider>
      </body>
    </html>
  );
}

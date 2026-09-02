import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ScanHistoryProvider } from "@/app/context/scan-history";
import { BrandProvider } from "@/app/context/brand";
import { HistorySidebar } from "@/components/nav/HistorySidebar";
import { getPublicBrand } from "@/lib/config";
import "./globals.css";

// brand.config.json is read at request time, not baked in at build time
export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "VerticalFlash",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const brand = getPublicBrand();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full">
        <BrandProvider value={brand}>
          <ScanHistoryProvider>
            <HistorySidebar />
            <main className="flex-1 min-w-0">{children}</main>
          </ScanHistoryProvider>
        </BrandProvider>
      </body>
    </html>
  );
}

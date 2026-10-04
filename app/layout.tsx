import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./ui-system.css";

export const metadata: Metadata = {
  title: "Cổng quản lý nội bộ",
  description: "Quản lý ca làm việc và đối chiếu dữ liệu theo thời gian thực.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/logo-transparent.png", apple: "/logo-transparent.png" },
};

export const viewport: Viewport = { themeColor: "#0b563d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="vi"><body>{children}</body></html>;
}

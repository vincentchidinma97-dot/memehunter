import "./globals.css";

export const metadata = {
  title: "Meme Hunter — paper desk",
  description: "Simulated meme coin flip testing. Not financial advice.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

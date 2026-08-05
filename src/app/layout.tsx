// Next requires a root layout, but every HTML-rendering route lives under
// [locale], which owns <html> so it can set lang from the active locale.
// This one is a pass-through.
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}

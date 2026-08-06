import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { PALETTE_BOOT_SCRIPT } from '@/lib/palette';
import { DENSITY_BOOT_SCRIPT } from '@/lib/density';

export const metadata: Metadata = {
  title: 'CRM Lead & Sales System',
  description: 'Outbound-calling sales CRM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Paints the chosen palette before anything renders. Same trick, and
            the same reason, as next-themes' own boot script sitting beside it:
            the choice lives on the server, and waiting for it would mean showing
            every user the default colours first and swapping them under them. */}
        <script dangerouslySetInnerHTML={{ __html: PALETTE_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: DENSITY_BOOT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

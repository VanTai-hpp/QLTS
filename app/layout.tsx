import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'CRM Tuyển Sinh Đa Cơ Sở',
  description: 'Hệ thống CRM quản lý tuyển sinh và chăm sóc học viên đa cơ sở (Bến Lức, Đức Hòa) tích hợp Firebase Firestore.',
  openGraph: {
    title: 'CRM Tuyển Sinh Đa Cơ Sở',
    description: 'Hệ thống CRM quản lý tuyển sinh và chăm sóc học viên đa cơ sở (Bến Lức, Đức Hòa) tích hợp Firebase Firestore.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CRM Tuyển Sinh Đa Cơ Sở',
    description: 'Hệ thống CRM quản lý tuyển sinh và chăm sóc học viên đa cơ sở (Bến Lức, Đức Hòa) tích hợp Firebase Firestore.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="vi">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}

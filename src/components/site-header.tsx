import { Separator } from '@/components/ui/separator'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'

export function SiteHeader({ title }: { title: string }) {
  const { isMobile, openMobile, open } = useSidebar()
  return <header className="staff-header">
    <SidebarTrigger className="staff-sidebar-trigger" aria-label={isMobile ? 'Open navigation' : open ? 'Collapse navigation' : 'Expand navigation'} aria-expanded={isMobile ? openMobile : open} />
    <Separator orientation="vertical" className="staff-header-separator" />
    <span className="staff-section-title">{title}</span>
  </header>
}

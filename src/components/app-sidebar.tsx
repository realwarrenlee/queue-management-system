import { BarChart3, Check, ClipboardList, CloudOff, Coffee, History, ListOrdered, LogOut, Monitor, AlertCircle, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Brand } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import type { Role } from '../../shared/domain'

type Props = {
  role: Role
  view: string
  active: number
  connected: boolean
  syncing: boolean
  pending: number
  rejected: boolean
  navigate: (view: string) => void
  showPending: () => void
  logout: () => void
}

export function AppSidebar({ role, view, active, connected, syncing, pending, rejected, navigate, showPending, logout }: Props) {
  const { isMobile, setOpenMobile } = useSidebar()
  const roleLabel = role === 'lead' ? 'Booth lead' : 'Barista'
  const pendingAfterClose = useRef(false)
  const [syncVisible, setSyncVisible] = useState(syncing)
  const syncStartedAt = useRef(0)
  useEffect(() => {
    if (syncing) {
      syncStartedAt.current = Date.now()
      setSyncVisible(true)
      return
    }
    // Hold the indicator only; order updates and error states remain immediate.
    const timer = setTimeout(() => setSyncVisible(false), Math.max(0, 2000 - (Date.now() - syncStartedAt.current)))
    return () => clearTimeout(timer)
  }, [syncing])
  const showSync = !rejected && (syncing || (syncVisible && connected))
  const syncLabel = showSync ? 'Syncing…' : pending ? `${pending} pending` : connected ? 'Synced' : 'Offline'
  const SyncIcon = rejected ? AlertCircle : showSync ? Spinner : !connected ? CloudOff : Check
  function select(value: string) {
    navigate(value)
    setOpenMobile(false)
  }
  const counter = [
    { value: 'order', label: 'Order', icon: Coffee, count: 0 },
    { value: 'queue', label: 'Queue', icon: ListOrdered, count: active },
  ]
  const shift = [
    { value: 'recent', label: 'Recent', icon: History, count: 0 },
    ...(role === 'lead' ? [
      { value: 'menu', label: 'Menu', icon: ClipboardList, count: 0 },
      { value: 'reports', label: 'Reports', icon: BarChart3, count: 0 },
    ] : []),
  ]
  return <Sidebar collapsible="icon" variant="inset" className="staff-sidebar" onMobileClose={() => { if (pendingAfterClose.current) { pendingAfterClose.current = false; showPending() } }}>
    <SidebarHeader className="staff-sidebar-header">
      <div className="sidebar-brand"><Brand showEvent={false} />{isMobile && <Button variant="ghost" size="icon" aria-label="Close navigation" onClick={() => setOpenMobile(false)}><X /></Button>}</div>
    </SidebarHeader>
    <SidebarContent>
      <nav aria-label="Staff navigation">
        {[{ label: 'At the counter', items: counter }, { label: 'Your shift', items: shift }].map(group => <SidebarGroup key={group.label}>
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarMenu>{group.items.map(item => <SidebarMenuItem key={item.value}>
            <SidebarMenuButton asChild isActive={view === item.value} tooltip={item.count ? `${item.label} · ${item.count}` : item.label}>
              <a href={`/staff/${item.value}`} aria-current={view === item.value ? 'page' : undefined} aria-label={item.count ? `${item.label}, ${item.count} ${item.count === 1 ? 'order' : 'orders'}` : item.label} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); select(item.value) } }}>
                <item.icon aria-hidden="true" /><span>{item.label}</span>
              </a>
            </SidebarMenuButton>
            {item.count > 0 && <SidebarMenuBadge aria-hidden="true">{item.count}</SidebarMenuBadge>}
          </SidebarMenuItem>)}{group.label === 'At the counter' && <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Display (opens in a new tab)">
              <a href="/board" target="_blank" rel="noreferrer" aria-label="Display (opens in a new tab)" onClick={() => setOpenMobile(false)}><Monitor aria-hidden="true" /><span>Display</span></a>
            </SidebarMenuButton>
          </SidebarMenuItem>}</SidebarMenu>
        </SidebarGroup>)}
      </nav>
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton id="staff-sync" tooltip={`${syncLabel} · View saved work`} aria-label={`${syncLabel} · View saved work`} className={!connected || pending ? 'sidebar-pending' : undefined} onClick={() => { if (isMobile) { pendingAfterClose.current = true; setOpenMobile(false) } else showPending() }}><SyncIcon aria-hidden="true" /><span>{syncLabel}</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton type="button" tooltip={roleLabel} aria-label={roleLabel}><UserRound aria-hidden="true" /><span className="group-data-[collapsible=icon]:hidden">{roleLabel}</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton tooltip="Sign out" onClick={() => { setOpenMobile(false); logout() }}><LogOut aria-hidden="true" /><span>Sign out</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
}

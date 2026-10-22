export function Brand({ showEvent = true }: { showEvent?: boolean }) {
  return <div className="brand" aria-label={showEvent ? 'beans&beats at Christmas Together' : 'beans&beats'}>
    <img className="brand-logo" src="/brand/beans-and-beats-logo-black.png" alt="" width="64" height="64" />
    <span className="brand-wordmark">beans&beats</span>
    {showEvent && <span className="brand-event">at Christmas<br />Together</span>}
  </div>
}

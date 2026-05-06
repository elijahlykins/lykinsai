import * as React from "react"

const MOBILE_BREAKPOINT = 768

// Treat the user as "mobile" only when the viewport is narrow AND the
// device itself looks like a touch-only device (coarse pointer, no hover).
// This prevents desktops/laptops in split-screen or narrow window modes
// from being misidentified as phones.
function getIsTouchOnlyDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false
  }
  try {
    return (
      window.matchMedia("(pointer: coarse)").matches &&
      window.matchMedia("(hover: none)").matches
    )
  } catch {
    return false
  }
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(undefined)

  React.useEffect(() => {
    const widthMql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const pointerMql = window.matchMedia("(pointer: coarse)")
    const hoverMql = window.matchMedia("(hover: none)")
    const update = () => {
      const narrow = window.innerWidth < MOBILE_BREAKPOINT
      setIsMobile(narrow && getIsTouchOnlyDevice())
    }
    widthMql.addEventListener("change", update)
    pointerMql.addEventListener("change", update)
    hoverMql.addEventListener("change", update)
    update()
    return () => {
      widthMql.removeEventListener("change", update)
      pointerMql.removeEventListener("change", update)
      hoverMql.removeEventListener("change", update)
    }
  }, [])

  return !!isMobile
}

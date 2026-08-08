/// <reference types="vite/client" />

declare global {
  interface WindowEventMap {
    'vpr:timeline-top': Event
  }
}

export {}

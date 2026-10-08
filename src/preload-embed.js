'use strict'

const { webFrame } = require('electron')

let zoom = 1
try { zoom = webFrame.getZoomFactor() || 1 } catch { }

function apply(next) {
  zoom = Math.min(3, Math.max(0.25, Math.round(next * 100) / 100))
  try { webFrame.setZoomFactor(zoom) } catch { }
}

window.addEventListener('wheel', (event) => {
  if (event.ctrlKey !== true) return
  event.preventDefault()
  apply(zoom + (event.deltaY > 0 ? -0.1 : 0.1))
}, { passive: false, capture: true })

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey !== true) return
  if (event.key === '=' || event.key === '+') { event.preventDefault(); apply(zoom + 0.1) }
  else if (event.key === '-') { event.preventDefault(); apply(zoom - 0.1) }
  else if (event.key === '0') { event.preventDefault(); apply(1) }
}, { capture: true })

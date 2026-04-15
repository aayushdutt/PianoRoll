export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function hexToCSS(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

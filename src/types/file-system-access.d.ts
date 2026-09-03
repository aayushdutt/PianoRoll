// Minimal File System Access API surface used by the exporter. Chrome/Edge
// desktop only; feature-detected at the call site. TS's DOM lib does not ship
// `showSaveFilePicker`, and FileSystemWritableFileStream lacks the object-form
// write we need for positioned writes.
interface SaveFilePickerType {
  description?: string
  accept: Record<string, string[]>
}
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: SaveFilePickerType[]
  excludeAcceptAllOption?: boolean
  id?: string
  startIn?: string
}
interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
}
interface FileSystemFileHandle {
  // Chromium-only (non-standard): deletes the entry this handle points to.
  remove?: () => Promise<void>
}

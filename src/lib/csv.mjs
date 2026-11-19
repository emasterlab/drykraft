export function csvCell(value) {
  let text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
  if (typeof value !== 'number' && /^[=+@\-]/.test(text.trimStart())) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

// Minimal mustache-like renderer: {{path}}, {{#if path}}...{{else}}...{{/if}}, {{#each path}}...{{/each}}
// No external dependency — templates are small and this is the entire feature set we need.

function getPath(data: unknown, path: string): unknown {
  if (path === 'this') return data
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined
    return (acc as Record<string, unknown>)[key]
  }, data)
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value)
}

export function render(template: string, data: Record<string, unknown>): string {
  // {{#each path}}...{{/each}} (non-nested each; inner content is re-rendered recursively per item)
  template = template.replace(/{{#each ([\w.]+)}}([\s\S]*?){{\/each}}/g, (_match, path: string, inner: string) => {
    const arr = getPath(data, path)
    if (!Array.isArray(arr)) return ''
    return arr
      .map((item) => render(inner, { ...data, ...(typeof item === 'object' && item !== null ? item : {}), this: item }))
      .join('')
  })

  // {{#if path}}...{{else}}...{{/if}}
  template = template.replace(
    /{{#if ([\w.]+)}}([\s\S]*?)(?:{{else}}([\s\S]*?))?{{\/if}}/g,
    (_match, path: string, whenTrue: string, whenFalse: string | undefined) => {
      const val = getPath(data, path)
      return isTruthy(val) ? render(whenTrue, data) : render(whenFalse ?? '', data)
    },
  )

  // {{path}}
  template = template.replace(/{{([\w.]+)}}/g, (_match, path: string) => {
    const val = getPath(data, path)
    return val === undefined || val === null ? '' : String(val)
  })

  return template
}

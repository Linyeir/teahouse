/**
 * Replaces `{{name}}` placeholders (case-insensitive, whitespace tolerant).
 * Unknown placeholders are left untouched so they stay visible in the output.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const lookup = new Map(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  return template.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (match, name: string) => {
    return lookup.get(name.toLowerCase()) ?? match;
  });
}

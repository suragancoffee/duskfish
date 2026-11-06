import ko from '../i18n/ko.json'

export type Dictionary = Record<string, string>
const DICTIONARY: Dictionary = ko

/** Korean-only game text. Missing keys render the key so gaps are visible. */
export class I18n {
  readonly locale = 'ko'
  constructor() {
    if (typeof document !== 'undefined') document.documentElement.lang = 'ko'
  }
  t(key: string, vars: Record<string, string | number> = {}): string {
    const text = DICTIONARY[key] ?? key
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
  }
  has(key: string): boolean {
    return key in DICTIONARY
  }
}

export const DICTIONARY_KEYS = Object.keys(ko)

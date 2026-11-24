/** OMS synthesizes an email for accounts that log in with a 工號. */
export const OMS_SYNTH_DOMAIN = '@id.syncmold.com.tw'

/**
 * Turn what the user typed (工號 or email) into the email OMS Auth expects.
 * Mirrors the OMS login page rule; returns null when nothing usable was typed.
 */
export function resolveLoginEmail(input: string): string | null {
  const value = input.trim().toLowerCase()
  if (!value) return null
  return value.includes('@') ? value : value + OMS_SYNTH_DOMAIN
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s-]/g, '')
}

export function isValidPhone(phone: string): boolean {
  return /^0\d{9}$/.test(normalizePhone(phone))
}

export function isValidPin(pin: string): boolean {
  if (!/^\d{6,8}$/.test(pin) || /^(\d)\1+$/.test(pin)) return false
  const digits = [...pin].map(Number)
  const ascending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] + 1)
  const descending = digits.every((digit, index) => index === 0 || digit === digits[index - 1] - 1)
  return !ascending && !descending
}

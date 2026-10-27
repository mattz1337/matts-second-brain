export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let sessionGeneration = 0;
export function resetApiSession() {
  sessionGeneration++;
}
export async function api<T>(url: string, body?: unknown, method?: string): Promise<T> {
  const generation = sessionGeneration;
  const response = await fetch(`/api${url}`, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers:
      body instanceof FormData
        ? undefined
        : body !== undefined
          ? { 'Content-Type': 'application/json' }
          : undefined,
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const result = await response.json();
      message = result.error?.message || message;
    } catch {
      /* preserve HTTP error */
    }
    if (response.status === 401 && url !== '/session' && generation === sessionGeneration)
      window.dispatchEvent(new Event('orbit:unauthorized'));
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}
export const key = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // LAN HTTP lacks randomUUID, but getRandomValues remains available.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const pretty = (value: string) =>
  value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(value),
      )
    : 'Not verified';

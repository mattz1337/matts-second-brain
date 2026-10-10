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
export const key = () => crypto.randomUUID();
export const pretty = (value: string) =>
  value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const date = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(value),
      )
    : 'Not verified';

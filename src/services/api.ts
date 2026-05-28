/* eslint-disable @typescript-eslint/no-explicit-any */
const API_URL = '/api';

const UNAUTHORIZED_EVENT = 'auth:unauthorized';

function getHeaders(extra?: HeadersInit): HeadersInit {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra || {}),
  };
}

export interface ApiError extends Error {
  status?: number;
  details?: any;
  payload?: any;
}

async function handleResponse(response: Response) {
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new Error('Unauthorized');
  }
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    const msg = (payload && (payload.error || payload.message)) || response.statusText;
    const err = new Error(typeof msg === 'string' ? msg : 'Request failed') as ApiError;
    err.status = response.status;
    if (payload && typeof payload === 'object') {
      err.details = payload.details;
      err.payload = payload;
    }
    throw err;
  }
  return payload;
}

async function request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: getHeaders(options.headers),
  });
  return handleResponse(response);
}

async function upload<T = any>(endpoint: string, formData: FormData): Promise<T> {
  const token = localStorage.getItem('token');
  const response = await fetch(`${API_URL}${endpoint}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  return handleResponse(response);
}

export const api = {
  get: <T = any>(endpoint: string) => request<T>(endpoint),
  post: <T = any>(endpoint: string, data?: any) => request<T>(endpoint, {
    method: 'POST',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  }),
  put: <T = any>(endpoint: string, data?: any) => request<T>(endpoint, {
    method: 'PUT',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  }),
  delete: <T = any>(endpoint: string) => request<T>(endpoint, { method: 'DELETE' }),
  upload: <T = any>(endpoint: string, formData: FormData) => upload<T>(endpoint, formData),
};

export const AUTH_UNAUTHORIZED_EVENT = UNAUTHORIZED_EVENT;

import { config } from './config.js';
import type { PfCalculateResponse, PfGenerateSeedResponse, PfRotateSeedResponse } from '@dicetilt/shared-types';

const headers = {
  'Content-Type': 'application/json',
  'x-pf-auth-token': config.pfAuthToken,
};

function makeTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export async function pfGenerateSeed(): Promise<PfGenerateSeedResponse> {
  const { signal, clear } = makeTimeoutSignal(config.pfTimeoutMs);
  try {
    const res = await fetch(`${config.pfWorkerUrl}/api/pf/generate-seed`, {
      method: 'POST',
      headers,
      signal,
    });
    if (!res.ok) throw new Error(`PF generate-seed failed: ${res.status}`);
    return res.json() as Promise<PfGenerateSeedResponse>;
  } finally {
    clear();
  }
}

export async function pfCalculate(
  clientSeed: string,
  nonce: number,
  serverSeed: string,
): Promise<PfCalculateResponse> {
  const { signal, clear } = makeTimeoutSignal(config.pfTimeoutMs);
  try {
    const res = await fetch(`${config.pfWorkerUrl}/api/pf/calculate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientSeed, nonce, serverSeed }),
      signal,
    });
    if (!res.ok) throw new Error(`PF calculate failed: ${res.status}`);
    return res.json() as Promise<PfCalculateResponse>;
  } finally {
    clear();
  }
}

export async function pfRotateSeed(currentServerSeed: string): Promise<PfRotateSeedResponse> {
  const { signal, clear } = makeTimeoutSignal(config.pfTimeoutMs);
  try {
    const res = await fetch(`${config.pfWorkerUrl}/api/pf/rotate-seed`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ currentServerSeed }),
      signal,
    });
    if (!res.ok) throw new Error(`PF rotate-seed failed: ${res.status}`);
    return res.json() as Promise<PfRotateSeedResponse>;
  } finally {
    clear();
  }
}

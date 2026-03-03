import { config } from './config.js';
import type { PfCalculateResponse, PfGenerateSeedResponse, PfRotateSeedResponse } from '@dicetilt/shared-types';

const headers = {
  'Content-Type': 'application/json',
  'x-pf-auth-token': config.pfAuthToken,
};

export async function pfGenerateSeed(): Promise<PfGenerateSeedResponse> {
  const res = await fetch(`${config.pfWorkerUrl}/api/pf/generate-seed`, {
    method: 'POST',
    headers,
  });
  if (!res.ok) throw new Error(`PF generate-seed failed: ${res.status}`);
  return res.json() as Promise<PfGenerateSeedResponse>;
}

export async function pfCalculate(
  clientSeed: string,
  nonce: number,
  serverSeed: string,
): Promise<PfCalculateResponse> {
  const res = await fetch(`${config.pfWorkerUrl}/api/pf/calculate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientSeed, nonce, serverSeed }),
  });
  if (!res.ok) throw new Error(`PF calculate failed: ${res.status}`);
  return res.json() as Promise<PfCalculateResponse>;
}

export async function pfRotateSeed(currentServerSeed: string): Promise<PfRotateSeedResponse> {
  const res = await fetch(`${config.pfWorkerUrl}/api/pf/rotate-seed`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ currentServerSeed }),
  });
  if (!res.ok) throw new Error(`PF rotate-seed failed: ${res.status}`);
  return res.json() as Promise<PfRotateSeedResponse>;
}

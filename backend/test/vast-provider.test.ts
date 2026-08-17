import { describe,expect,it } from 'vitest';
import { VastAiClient,VastProviderError } from '../src/vast-market/provider.js';

const json = (body: unknown,status=200) => new Response(JSON.stringify(body),{
  status,headers: { 'content-type': 'application/json' },
});
const validOffer = { id: 123,gpu_name: 'RTX 4090',num_gpus: 1,gpu_ram: 24576,dph_total: 0.5,
  geolocation: 'Shanghai, CN',reliability: 0.998,verification: 'verified',rentable: true,rented: false,is_bid: false };

describe('Vast.ai HTTP adapter',() => {
  it('uses the official safe on-demand filters and exposes only verified rentable offers',async () => {
    let capturedUrl = ''; let captured: RequestInit | undefined;
    const client = new VastAiClient('https://console.vast.ai','vast-secret',async (url,init) => {
      capturedUrl = String(url); captured = init;
      return json({ offers: [validOffer,{ ...validOffer,id: 456,verification: 'unverified' }] });
    });
    const offers = await client.search({ gpuName: 'RTX 4090',minimumReliability: 0.99 });
    expect(capturedUrl).toBe('https://console.vast.ai/api/v0/bundles/');
    expect(captured?.headers).toMatchObject({ authorization: 'Bearer vast-secret' });
    expect(JSON.parse(String(captured?.body))).toMatchObject({ type: 'ondemand',verified: { eq: true },
      rentable: { eq: true },rented: { eq: false },gpu_name: { eq: 'RTX 4090' } });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ offerId: '123',providerCostMicrosPerHour: 500_000n });
  });

  it('retries safe searches after timeouts but never retries instance creation',async () => {
    let searchCalls = 0;
    const search = new VastAiClient('https://console.vast.ai','key',async () => {
      searchCalls += 1;
      if (searchCalls < 3) throw new DOMException('timeout','TimeoutError');
      return json({ offers: [validOffer] });
    },10,3,async () => undefined);
    await expect(search.search({})).resolves.toHaveLength(1);
    expect(searchCalls).toBe(3);

    let createCalls = 0;
    const create = new VastAiClient('https://console.vast.ai','key',async () => {
      createCalls += 1; throw new DOMException('timeout','TimeoutError');
    },10,3,async () => undefined);
    await expect(create.createInstance({ offerId: '123',label: 'zod-vast-request',
      configuration: { image: 'vastai/base-image:latest',diskGb: 32,runtype: 'ssh_direct' } }))
      .rejects.toEqual(expect.objectContaining<Partial<VastProviderError>>({
        code: 'VAST_TIMEOUT',retryable: true,outcomeUnknown: true,
      }));
    expect(createCalls).toBe(1);
  });

  it('requires an explicit contract id before treating creation as successful',async () => {
    const malformed = new VastAiClient('https://console.vast.ai','key',async () => json({ success: true }));
    await expect(malformed.createInstance({ offerId: '123',label: 'zod-vast-request',
      configuration: { image: 'vastai/base-image:latest',diskGb: 32,runtype: 'ssh_direct' } }))
      .rejects.toEqual(expect.objectContaining({ code: 'VAST_INVALID_RESPONSE',outcomeUnknown: true }));
    const valid = new VastAiClient('https://console.vast.ai','key',async () => json({ success: true,new_contract: 987 }));
    await expect(valid.createInstance({ offerId: '123',label: 'zod-vast-request',
      configuration: { image: 'vastai/base-image:latest',diskGb: 32,runtype: 'ssh_direct' } }))
      .resolves.toEqual({ contractId: '987' });
  });
});

export type SandboxProvider = 'giftcards' | 'loyalty';
export type VerifySandboxKey = (
  provider: SandboxProvider,
  key: string,
) => Promise<boolean>;

export function createOutboundSandbox(
  provider: SandboxProvider,
  verifyKey: VerifySandboxKey,
) {
  return async (request: Request): Promise<Response> => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Allow: 'GET, HEAD, POST',
    };
    const identity = {
      provider,
      environment: 'sandbox',
      status: 'not_implemented',
      transactionsEnabled: false,
    };
    if (request.method === 'HEAD')
      return new Response(null, { status: 200, headers });
    if (request.method === 'GET') {
      return Response.json(
        {
          ...identity,
          purpose:
            'Toast sandbox onboarding endpoint; transaction processing is not implemented.',
        },
        { headers },
      );
    }
    if (request.method !== 'POST') {
      return Response.json(
        { ...identity, error: 'METHOD_NOT_ALLOWED' },
        { status: 405, headers },
      );
    }
    const key = request.headers.get('Authorization') ?? '';
    if (key.length < 32 || key.length > 255) {
      return Response.json(
        { ...identity, transactionStatus: 'ERROR_INVALID_TOKEN' },
        { status: 401, headers },
      );
    }
    let authenticated;
    try {
      authenticated = await verifyKey(provider, key);
    } catch {
      return Response.json(
        { ...identity, error: 'AUTHENTICATION_UNAVAILABLE' },
        { status: 503, headers },
      );
    }
    if (!authenticated) {
      return Response.json(
        { ...identity, transactionStatus: 'ERROR_INVALID_TOKEN' },
        { status: 401, headers },
      );
    }
    return Response.json(
      {
        ...identity,
        transactionStatus: 'ERROR_INVALID_INPUT_PROPERTIES',
        message:
          'Sandbox transaction processing is not implemented. No balances, rewards, or orders were changed.',
      },
      { status: 503, headers },
    );
  };
}

import {
  createOutboundSandbox,
  type SandboxProvider,
} from './outbound-sandbox.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
const key = 'sandbox-test-key-with-at-least-32-characters';

for (const provider of ['giftcards', 'loyalty'] as SandboxProvider[]) {
  Deno.test(
    `${provider} onboarding status is explicit and never reports transaction readiness`,
    async () => {
      const handler = createOutboundSandbox(provider, async () => {
        throw new Error('GET must not authenticate');
      });
      const response = await handler(
        new Request('https://example.test/' + provider),
      );
      const data = await response.json();
      assert(
        response.status === 200 &&
          data.provider === provider &&
          data.environment === 'sandbox',
        'Status must identify the sandbox provider',
      );
      assert(
        data.transactionsEnabled === false && data.status === 'not_implemented',
        'Do not imply certified or working transaction handling',
      );
      assert(
        response.headers.get('Cache-Control') === 'no-store',
        'Do not cache endpoint status',
      );
    },
  );

  Deno.test(
    `${provider} rejects unauthorized, unsupported and authenticated transactions without accepting`,
    async () => {
      let verifications = 0;
      const handler = createOutboundSandbox(
        provider,
        async (receivedProvider, receivedKey) => {
          verifications++;
          return receivedProvider === provider && receivedKey === key;
        },
      );
      const url = 'https://example.test/' + provider;
      assert(
        (await handler(new Request(url, { method: 'POST' }))).status === 401,
        'Missing key must fail',
      );
      assert(
        verifications === 0,
        'Missing credentials must not reach the database',
      );
      assert(
        (await handler(new Request(url, { method: 'DELETE' }))).status === 405,
        'Unsupported method must fail',
      );
      const invalid = await handler(
        new Request(url, {
          method: 'POST',
          headers: {
            Authorization: 'incorrect-sandbox-key-with-32-characters',
          },
        }),
      );
      assert(invalid.status === 401, 'Incorrect key must fail');
      const request = () =>
        new Request(url, {
          method: 'POST',
          headers: {
            Authorization: key,
            'Toast-Transaction-GUID': '00000000-0000-4000-8000-000000000001',
          },
          body: '{"giftCardIdentifier":"do-not-log","amount":100}',
        });
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await handler(request());
        const text = await response.text();
        assert(
          response.status === 503 && text.includes('not_implemented'),
          'Authenticated operations must remain unavailable',
        );
        assert(
          !text.includes('ACCEPT') &&
            !text.includes('do-not-log') &&
            !text.includes(key),
          'Never approve, echo identifiers, or disclose credentials',
        );
      }
      const unavailable = createOutboundSandbox(provider, async () => {
        throw new Error('database unavailable');
      });
      assert(
        (await unavailable(request())).status === 503,
        'Authentication dependency failure must fail closed',
      );
    },
  );
}

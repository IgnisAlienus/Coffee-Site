import {
  freshness,
  publicCatalog,
  publicState,
  SOURCES,
  type Snapshot,
} from './domain.ts';
import {
  applyMenuOverrides,
  limitedBody,
  menuEntities,
  photoExtension,
  validateOverride,
} from './menu-overrides.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test('modifier prices and stock include nested options without exposing inventory quantities', () => {
  const visibility = ['TOAST_ONLINE_ORDERING'];
  const payload = {
    menus: [{ visibility, menuGroups: [{ visibility, menuItems: [{ guid: 'coffee', visibility, modifierGroupReferences: [1] }] }] }],
    modifierGroupReferences: {
      '1': { guid: 'flavors', visibility, pricingStrategy: 'NONE', modifierOptionReferences: [2, 3, 4, 5] },
      '6': { guid: 'extras', visibility, pricingStrategy: 'NONE', modifierOptionReferences: [7] },
    },
    modifierOptionReferences: {
      '2': { guid: 'vanilla-v2', multiLocationId: 'vanilla-stable', name: 'Vanilla', visibility, pricingStrategy: 'GROUP_PRICE', price: 0.75, modifierGroupReferences: [6] },
      '3': { guid: 'free', name: 'No ice', visibility, pricingStrategy: 'BASE_PRICE', price: 0 },
      '4': { guid: 'milk', name: 'Oat milk', visibility, pricingStrategy: 'BASE_PRICE', price: 1 },
      '5': { guid: 'syrup', name: 'Syrup', visibility, pricingStrategy: 'MENU_SPECIFIC_PRICE', price: 0.5 },
      '7': { guid: 'nested', name: 'Extra shot', visibility, pricingStrategy: 'BASE_PRICE', price: 1.5 },
    },
  };
  const stock = [
    { guid: 'old-vanilla', multiLocationId: 'vanilla-stable', status: 'QUANTITY', quantity: 4 },
    { guid: 'milk', status: 'OUT_OF_STOCK', quantity: null },
    { guid: 'nested', status: 'QUANTITY', quantity: 5 },
  ];
  const result = publicCatalog(payload, stock, true);
  const options = result.menus[0].groups[0].items[0].modifierGroups[0].options;
  assert(options[0].price === 0.75 && options[0].stockStatus === 'LIMITED', 'Group-resolved price and stable stock identity must be used');
  assert(options[1].price === 0 && options[1].stockStatus === 'IN_STOCK', 'Free modifiers keep zero for omission in the UI');
  assert(options[2].price === 1 && options[2].stockStatus === 'OUT_OF_STOCK', 'Sold-out modifiers remain visible with their price');
  assert(options[3].price === 0.5 && options[3].stockStatus === 'IN_STOCK', 'Menu-specific modifier prices must be preserved');
  assert(options[0].groups[0].options[0].price === 1.5 && options[0].groups[0].options[0].stockStatus === 'IN_STOCK', 'Nested modifiers must include price and stock');
  assert(!JSON.stringify(result).includes('quantity'), 'Inventory counts must remain private');
  assert(publicCatalog(payload, stock, false).menus[0].groups[0].items[0].modifierGroups[0].options.every(option => option.stockStatus === 'UNKNOWN'), 'Stale modifier stock must be unknown');
});

Deno.test('included defaults do not show a surcharge and conditional group prices are not invented', () => {
  const visibility = ['TOAST_ONLINE_ORDERING'];
  const payload = {
    menus: [{ visibility, menuGroups: [{ visibility, menuItems: [{ guid: 'coffee', visibility, modifierGroupReferences: [1, 2] }] }] }],
    modifierGroupReferences: {
      '1': { guid: 'defaults', visibility, pricingStrategy: 'NONE', defaultOptionsChargePrice: 'NO', modifierOptionReferences: [3, 4, 5] },
      '2': { guid: 'conditional', visibility, pricingStrategy: 'SEQUENCE_PRICE', modifierOptionReferences: [6] },
    },
    modifierOptionReferences: {
      '3': { guid: 'included', visibility, isDefault: true, pricingStrategy: 'BASE_PRICE', price: 1 },
      '4': { guid: 'charged', visibility, isDefault: true, shouldChargePrice: true, pricingStrategy: 'BASE_PRICE', price: 1 },
      '5': { guid: 'free-default', visibility, isDefault: true, shouldChargePrice: false, pricingStrategy: 'BASE_PRICE', price: 1 },
      '6': { guid: 'conditional-option', visibility, pricingStrategy: 'GROUP_PRICE', price: 99 },
    },
  };
  const groups = publicCatalog(payload).menus[0].groups[0].items[0].modifierGroups;
  assert(groups[0].options[0].price === 0 && groups[0].options[2].price === 0, 'Included defaults must not imply an extra charge');
  assert(groups[0].options[1].price === 1, 'An explicit default charging override takes precedence');
  assert(groups[1].options[0].price === null && groups[1].options[0].startingPrice === null, 'Sequence-dependent prices must not become a fixed price');
});

const now = Date.parse('2026-10-15T12:00:00Z');
const snapshots: Snapshot[] = SOURCES.map((source) => ({
  source,
  fetched_at: new Date(now).toISOString(),
  payload: { status: 'ONLINE' },
}));

Deno.test(
  'read access never enables checkout even with fresh online data',
  () => {
    const result = publicState(snapshots, now);
    assert(
      result.restaurantStatus === 'ONLINE',
      'Fresh availability should be visible',
    );
    assert(
      result.checkoutEnabled === false && result.acceptingOrders === false,
      'Must remain read-only',
    );
  },
);

Deno.test('missing, expired, invalid and future timestamps fail closed', () => {
  assert(
    freshness([], now).every((source) => source.stale),
    'Missing sources must be stale',
  );
  for (const fetched_at of [
    'invalid',
    new Date(now - 121_000).toISOString(),
    new Date(now + 60_000).toISOString(),
  ]) {
    const data = [
      {
        source: 'availability' as const,
        fetched_at,
        payload: { status: 'ONLINE' },
      },
    ];
    assert(
      publicState(data, now).restaurantStatus === 'UNKNOWN',
      'Untrustworthy availability must be unknown',
    );
  }
});

Deno.test(
  'catalog filters POS-only ancestors and items and does not leak raw fields',
  () => {
    const visibility = ['TOAST_ONLINE_ORDERING'];
    const item = {
      guid: 'coffee',
      name: 'Coffee',
      visibility,
      price: 4,
      pricingStrategy: 'BASE_PRICE',
      secret: 'private',
    };
    const result = publicCatalog({
      menus: [
        {
          guid: 'hidden',
          name: 'Staff menu',
          visibility: ['POS'],
          menuGroups: [{ visibility, menuItems: [item] }],
        },
        {
          guid: 'public',
          name: 'Drinks',
          visibility,
          menuGroups: [
            {
              guid: 'group',
              visibility,
              menuItems: [
                item,
                { ...item, guid: 'hidden-item', visibility: ['POS'] },
              ],
            },
          ],
        },
      ],
    });
    const json = JSON.stringify(result);
    assert(result.menus.length === 1, 'Hidden parent menu must be excluded');
    assert(
      !json.includes('hidden-item') && !json.includes('private'),
      'Private data must be excluded',
    );
    assert(json.includes('"basePrice":4'), 'Simple price should be preserved');
  },
);

Deno.test(
  'complex prices and malformed payloads do not invent a price or menu',
  () => {
    assert(
      publicCatalog(null).menus.length === 0,
      'Invalid payload must be empty',
    );
    const visibility = ['TOAST_ONLINE_ORDERING'];
    const result = publicCatalog({
      menus: [
        {
          visibility,
          menuGroups: [
            {
              visibility,
              menuItems: [
                { visibility, pricingStrategy: 'SIZE_PRICE', price: 0 },
              ],
            },
          ],
        },
      ],
    });
    assert(
      JSON.stringify(result).includes('"basePrice":null'),
      'Variable pricing must not be displayed as free',
    );
  },
);

Deno.test(
  'stock freshness and multi-location identifiers control public stock labels',
  () => {
    const visibility = ['TOAST_ONLINE_ORDERING'];
    const payload = {
      menus: [
        {
          visibility,
          menuGroups: [
            {
              visibility,
              menuItems: [
                {
                  visibility,
                  guid: 'new-version',
                  multiLocationId: 'stable-id',
                },
              ],
            },
          ],
        },
      ],
    };
    const inventory = [
      {
        guid: 'old-version',
        multiLocationId: 'stable-id',
        status: 'OUT_OF_STOCK',
      },
    ];
    assert(
      JSON.stringify(publicCatalog(payload, inventory, true)).includes(
        '"stockStatus":"OUT_OF_STOCK"',
      ),
      'Match stable item identity',
    );
    assert(
      JSON.stringify(publicCatalog(payload, inventory, false)).includes(
        '"stockStatus":"UNKNOWN"',
      ),
      'Stale stock must be unknown',
    );
  },
);

Deno.test(
  'online overrides rename and hide without mutating Toast data and survive version changes',
  () => {
    const visibility = ['TOAST_ONLINE_ORDERING'];
    const original = {
      menus: [
        {
          guid: 'menu',
          multiLocationId: '100',
          name: 'POS Menu',
          visibility,
          menuGroups: [
            {
              guid: 'group',
              name: 'POS Group',
              visibility,
              menuItems: [
                {
                  guid: 'item-v2',
                  multiLocationId: '200',
                  name: 'Latte',
                  visibility,
                  modifierGroupReferences: [1],
                },
              ],
            },
          ],
        },
      ],
      modifierGroupReferences: {
        '1': {
          guid: 'milk',
          name: 'Milk',
          visibility,
          modifierOptionReferences: [2, 3],
        },
      },
      modifierOptionReferences: {
        '2': { guid: 'oat', name: 'Oat milk', visibility },
        '3': { guid: 'whole', name: 'Whole milk', visibility },
      },
    };
    const overrides = [
      validateOverride({
        entity_type: 'menu',
        entity_id: 'ml:100',
        display_name: 'Coffee',
        hidden: false,
        photo_url: null,
      }),
      validateOverride({
        entity_type: 'item',
        entity_id: 'ml:200',
        display_name: null,
        hidden: false,
        photo_url: 'https://photos.example/latte.jpg',
      }),
      validateOverride({
        entity_type: 'modifier',
        entity_id: 'guid:oat',
        display_name: null,
        hidden: true,
        photo_url: null,
      }),
    ];
    const result = publicCatalog(applyMenuOverrides(original, overrides));
    assert(result.menus[0].name === 'Coffee', 'Override must rename the menu');
    const item = result.menus[0].groups[0].items[0];
    assert(
      item.photoUrl === 'https://photos.example/latte.jpg',
      'Stable item override must apply to new GUID version',
    );
    assert(
      item.modifierGroups[0].options.length === 1 &&
        item.modifierGroups[0].options[0].id === 'whole',
      'Hidden modifier must be absent',
    );
    assert(
      original.menus[0].name === 'POS Menu' &&
        original.modifierOptionReferences['2'].visibility.length === 1,
      'Toast snapshot must remain unchanged',
    );
    overrides[0].hidden = true;
    assert(
      publicCatalog(applyMenuOverrides(original, overrides)).menus.length === 0,
      'Hiding a menu removes all descendants',
    );
    assert(
      menuEntities(original, overrides).find(
        (entry) => entry.entityId === 'ml:100',
      )?.hidden,
      'Editor must retain hidden entities for restoring',
    );
  },
);

Deno.test(
  'online overrides cannot make POS-only entities public or accept unsafe photos',
  () => {
    const payload = {
      menus: [{ guid: 'menu', name: 'Staff', visibility: ['POS'] }],
    };
    const override = validateOverride({
      entity_type: 'menu',
      entity_id: 'guid:menu',
      display_name: 'Public?',
      hidden: false,
      photo_url: null,
    });
    assert(
      publicCatalog(applyMenuOverrides(payload, [override])).menus.length === 0,
      'Overrides cannot expand Toast visibility',
    );
    for (const photo_url of [
      'javascript:alert(1)',
      'data:image/svg+xml,test',
      'http://photos.example/image.jpg',
    ]) {
      let rejected = false;
      try {
        validateOverride({
          entity_type: 'item',
          entity_id: 'guid:item',
          display_name: null,
          hidden: false,
          photo_url,
        });
      } catch {
        rejected = true;
      }
      assert(rejected, 'Unsafe photo URLs must be rejected');
    }
  },
);

Deno.test(
  'photo uploads check file signatures and enforce streamed body limits',
  async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    assert(
      photoExtension(png, 'image/png') === 'png',
      'PNG signature should match',
    );
    let rejected = false;
    try {
      photoExtension(new TextEncoder().encode('<svg/>'), 'image/png');
    } catch {
      rejected = true;
    }
    assert(rejected, 'Disguised SVG must be rejected');
    rejected = false;
    try {
      await limitedBody(
        new Request('https://example.test', { method: 'POST', body: '12345' }),
        4,
      );
    } catch {
      rejected = true;
    }
    assert(rejected, 'Actual body size must be bounded');
  },
);

Deno.test(
  'starting prices use the linked visible size group and preserve zero without guessing',
  () => {
    const visibility = ['TOAST_ONLINE_ORDERING'];
    const item = {
      guid: 'latte',
      visibility,
      pricingStrategy: 'SIZE_PRICE',
      price: 0,
      pricingRules: { sizeSpecificPricingGuid: 'sizes' },
      modifierGroupReferences: [1],
    };
    const payload = {
      menus: [{ visibility, menuGroups: [{ visibility, menuItems: [item] }] }],
      modifierGroupReferences: {
        '1': { guid: 'sizes', visibility, modifierOptionReferences: [2, 3, 4] },
      },
      modifierOptionReferences: {
        '2': { visibility, pricingStrategy: 'BASE_PRICE', price: 5.5 },
        '3': { visibility, pricingStrategy: 'BASE_PRICE', price: 6.5 },
        '4': { visibility: ['POS'], pricingStrategy: 'BASE_PRICE', price: 1 },
      },
    };
    const price = () =>
      publicCatalog(payload).menus[0].groups[0].items[0].startingPrice;
    assert(
      price() === 5.5,
      'Minimum must exclude POS-only sizes and zero placeholder item price',
    );
    payload.modifierOptionReferences['2'].visibility = [];
    assert(price() === 6.5, 'Hidden sizes must not lower the starting price');
    payload.modifierOptionReferences['3'].price = 0;
    assert(
      price() === 0,
      'A genuine zero must remain zero for the frontend to omit',
    );
    item.pricingRules.sizeSpecificPricingGuid = 'missing';
    assert(price() === null, 'Missing pricing rules must not invent a price');
  },
);

Deno.test(
  'public stock uses the below-five threshold, keeps sold-out items and never exposes counts',
  () => {
    const visibility = ['TOAST_ONLINE_ORDERING'];
    const payload = {
      menus: [
        {
          visibility,
          menuGroups: [
            {
              visibility,
              menuItems: [{ guid: 'coffee', name: 'Coffee', visibility }],
            },
          ],
        },
      ],
    };
    const cases: { inventory: unknown; expected: string }[] = [
      {
        inventory: { status: 'QUANTITY', quantity: 0 },
        expected: 'OUT_OF_STOCK',
      },
      {
        inventory: { status: 'QUANTITY', quantity: -1 },
        expected: 'OUT_OF_STOCK',
      },
      { inventory: { status: 'QUANTITY', quantity: 0.5 }, expected: 'LIMITED' },
      { inventory: { status: 'QUANTITY', quantity: 4 }, expected: 'LIMITED' },
      {
        inventory: { status: 'QUANTITY', quantity: 4.99 },
        expected: 'LIMITED',
      },
      { inventory: { status: 'QUANTITY', quantity: 5 }, expected: 'IN_STOCK' },
      { inventory: { status: 'QUANTITY', quantity: 25 }, expected: 'IN_STOCK' },
      {
        inventory: { status: 'QUANTITY', quantity: null },
        expected: 'UNKNOWN',
      },
      { inventory: { status: 'QUANTITY', quantity: '3' }, expected: 'UNKNOWN' },
      { inventory: { status: 'QUANTITY' }, expected: 'UNKNOWN' },
      { inventory: { status: 'QUANTITY', quantity: NaN }, expected: 'UNKNOWN' },
      {
        inventory: { status: 'QUANTITY', quantity: Infinity },
        expected: 'UNKNOWN',
      },
      {
        inventory: { status: 'IN_STOCK', quantity: null },
        expected: 'IN_STOCK',
      },
      {
        inventory: { status: 'OUT_OF_STOCK', quantity: 10 },
        expected: 'OUT_OF_STOCK',
      },
    ];
    for (const entry of cases) {
      const result = publicCatalog(
        payload,
        [{ guid: 'coffee', ...(entry.inventory as object) }],
        true,
      );
      const items = result.menus[0].groups[0].items;
      assert(
        items.length === 1,
        'Stock status must never remove an online-visible item',
      );
      assert(
        items[0].stockStatus === entry.expected,
        `Expected ${entry.expected}`,
      );
      assert(
        !JSON.stringify(result).includes('quantity'),
        'Inventory counts must stay private',
      );
    }
    assert(
      publicCatalog(payload, [], true).menus[0].groups[0].items[0]
        .stockStatus === 'IN_STOCK',
      'Fresh exception lists omit unrestricted items',
    );
    assert(
      publicCatalog(
        payload,
        [{ guid: 'coffee', status: 'QUANTITY', quantity: 4 }],
        false,
      ).menus[0].groups[0].items[0].stockStatus === 'UNKNOWN',
      'Stale counts must not produce stock claims',
    );
  },
);

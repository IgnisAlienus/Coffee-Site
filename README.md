# Firehouse Coffee Co.

The public website remains compatible with GitHub Pages. Supabase supplies PostgreSQL, staff authentication, and the server-side Toast connector. No Toast credentials belong in the website or a mobile app.

## Current scope

- `/order/`: searchable, read-only Toast V2 menu with base prices and item stock indicators. Customers complete customization and checkout on Toast.
- `/admin/`: staff password sign-in, manager TOTP enrollment/verification, paginated order lists/details, manager order timelines, source freshness, connection logs, individual-source refresh controls, and Sync All.
- Versioned JSON API: `/functions/v1/ordering-api/v1`.
- Order and append-only event tables with row-level security. Employees can view orders; managers need MFA to view orders and sensitive logs. Clients cannot insert or change orders, events, roles, or snapshots.
- Shared, browser-independent fetch client and TypeScript API types for a future mobile app.

There is no custom cart, payment entry, order submission/retry worker, historical Toast order import, or production webhook in this phase. Read-only Toast data has an automatic synchronization worker with controlled retries. The order list starts empty. No sample orders or menu data are inserted. Read-only access never enables custom checkout.

## Local preview and checks

Requires Node.js 20 or newer. Node dependencies include the Deno runtime, Supabase CLI, and an embedded PostgreSQL test runtime.

```powershell
npm install
npm test
npm run test:client
npm run test:db
npm run check
npm run test:pages
npm run build:pages
npx --yes --package http-server http-server . -a 127.0.0.1 -p 4173 -c-1
```

Open `http://127.0.0.1:4173/order/` or `http://127.0.0.1:4173/admin/`. JavaScript modules need an HTTP preview rather than opening these two pages as local files. Until configured, the ordering page links to Toast and staff sign-in reports that the service is unavailable.

Database tests execute the migrations in embedded PostgreSQL with test substitutes for Supabase's `auth` schema and Vault/cron/HTTP extensions. They verify anonymous denial, inactive staff denial, manager MFA, role restrictions, audited menu edits, worker lease ownership, per-source cooldowns, shared request pacing, auth-refresh throttling, scheduler authentication, and duplicate minute-tick prevention. Hosted extensions, authentication, cron invocation, and real Toast responses still need an integration check after deployment.

## Connect Supabase

1. Create a Supabase project in a suitable region and enable backups appropriate to the eventual order workload. Keep production and development in separate projects.
2. In hosted Authentication settings, disable public signup, enable TOTP MFA, and set the Site URL to `https://fhcoffee.co`. The repository's `config.toml` applies to the local stack; deploying an Edge Function does not automatically update hosted Auth settings.
3. Authenticate and link the CLI. Enter credentials directly into the terminal or Supabase dashboard, never into chat or committed files.

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

4. Set these Edge Function secrets in the Supabase dashboard. Use the Toast API hostname assigned to your account; the example hostname is not a guarantee of your account's environment.

| Secret | Value |
| --- | --- |
| `TOAST_API_BASE_URL` | Assigned HTTPS Toast API origin, without a path |
| `TOAST_CLIENT_ID` | Toast client ID |
| `TOAST_CLIENT_SECRET` | Toast client secret |
| `TOAST_RESTAURANT_GUID` | Optional for a single accessible location; required to select among multiple locations. Use Find Restaurants to look it up. Never use the management-group GUID. |
| `ALLOWED_ORIGINS` | Comma-separated browser origins, e.g. `https://fhcoffee.co,http://127.0.0.1:4173` |

Supabase supplies its project URL and service keys to the Edge Function. Both legacy environment keys and the newer named-key dictionaries are supported. Service keys never reach browser responses.

For local Edge Function development, use the ignored `supabase/functions/.env` file, based on the provided example. The Supabase local stack additionally requires Docker. Do not expose a development static server to the internet or use it to serve a directory containing real secrets to untrusted users.

5. Deploy the function:

```powershell
npx supabase functions deploy ordering-api
```

`verify_jwt = false` is intentional because the catalog is public. Every staff route explicitly validates the user with Supabase Auth, checks active database membership, and enforces the required role/MFA. CORS is not treated as authentication. Native apps may omit an Origin header but still need staff authentication for staff routes.

6. Update the two public values in `assets/config.js`: your Supabase project URL and publishable key (or legacy `anon` key). These are public identifiers; security comes from the backend and database policies. Never put a service-role key, `sb_secret_` key, Toast secret, or staff password there.
7. In GitHub repository **Settings > Pages**, select **GitHub Actions** as the build source. The `Deploy Website` workflow runs on pushes to `main` or a manual workflow dispatch, tests the backend/client/database/package, and uploads only `.pages-dist`. Keep `CNAME` set to `fhcoffee.co`; this workflow does not change DNS or redeploy Supabase.

## Publish the website

The live architecture is GitHub Pages for the static frontend and Supabase for Edge Functions, database, Auth, Storage, and scheduled sync. No Linux VPS is needed for the current release.

`npm run build:pages` creates a clean `.pages-dist` folder from an explicit public-file list. It includes the homepage, order/admin pages, shared browser client, styles, images, PDFs, custom-domain file, and `.nojekyll`. Backend source, SQL, tests, scripts, dependencies, environment files, and development metadata are excluded from the Pages artifact. The build rejects missing files and non-public Supabase configuration. The publishable key is intentionally public; Toast credentials and service keys remain in Supabase.

After a push to `main`, **Actions > Deploy Website** must complete both build and deploy jobs. Check `https://fhcoffee.co/`, `/order/`, and `/admin/`; confirm menu loading and staff authentication. The backend must allow `https://fhcoffee.co` in `ALLOWED_ORIGINS`. Until custom checkout is implemented and approved, customers still complete orders and payments on Toast.

No GitHub secret is required to publish the static site: the workflow uses GitHub's short-lived deployment token and Pages OIDC permission. Supabase changes remain a separate deployment with `supabase db push` and `supabase functions deploy ordering-api`. Do not put production backend secrets into Actions just to deploy Pages.

To recover from a frontend regression, redeploy a known-good commit through the same workflow. Reverting the frontend does not revert database migrations or the Supabase backend. The Pages artifact excludes backend files, but this repository itself may be public; never commit secrets anywhere in the repository.

## Provision staff

Create individual staff users through Supabase Authentication's administrative interface. Assign their role using the SQL editor, replacing the user UUID:

```sql
insert into public.staff_members(user_id, role)
values ('00000000-0000-0000-0000-000000000000', 'manager');
```

Use `employee` for employees. Staff cannot create accounts, promote themselves, or reactivate their membership. To revoke staff access immediately:

```sql
update public.staff_members set active = false
where user_id = '00000000-0000-0000-0000-000000000000';
```

Managers enroll an authenticator at their first sign-in. Manager operational data requires an `aal2` session in both the API and database. Staff sessions live in memory, not localStorage, so reloading the page requires signing in again. Plan an administrator-controlled recovery process for lost authenticators; do not add an MFA bypass to the application.

## Verify the Toast connection

1. Sign in as a manager, complete MFA, open **Toast Connection**, and select **Find Restaurants**. This uses the server-side credentials to call `/partners/v1/restaurants` without needing a GUID first. Only restaurant GUIDs, restaurant names, and location names are returned to the manager; tokens and employee emails are excluded.
2. If exactly one location is accessible and `TOAST_RESTAURANT_GUID` is unset, **Sync All** automatically resolves that location. No secret update is needed. If multiple locations are returned, set `TOAST_RESTAURANT_GUID` in Supabase Edge Function secrets to the individual store GUID before syncing. The integration never guesses among multiple locations. An existing configured GUID takes precedence; subsequent runs can reuse the GUID from the imported menu instead of repeating discovery.
3. If Toast denies discovery, the panel reports `DISCOVERY_NOT_PERMITTED`. Toast's Standard API credentials documentation mentions retrieving GUIDs through the Partners API, while its location-access documentation describes this endpoint as partner-only. Actual account eligibility must be verified. The Standard API activation email also lists location names and GUIDs; use that GUID or contact Toast support, then set the secret manually. A management-group GUID from an authentication token is not a restaurant GUID and must not be substituted.
4. Select **Sync All**, or the refresh icon beside a single source, and review the results. A denied scope, upstream outage, or malformed response is logged using a sanitized code and HTTP status, never a token or raw upstream response. Discovery attempts are also recorded in connection logs.
5. Check the customer menu and compare it with the restaurant's Toast menu. This initial preview uses `TOAST_ONLINE_ORDERING` visibility and excludes hidden parents and items. Confirm the channel required by Toast before enabling a custom ordering integration; ordering partners currently require V3 and `menus.channel:read`.

| Source | Read endpoint |
| --- | --- |
| Menus | `/menus/v2/menus` |
| Dining options | `/config/v2/diningOptions` |
| Ordering schedule | `/ordermgmt-config/v1/published/orderingSchedule` |
| Live availability | `/restaurant-availability/v1/availability` |
| Stock exceptions | `/stock/v1/inventory` |
| Restaurant information | `/restaurants/v1/restaurants/{guid}` |
| Taxes | `/config/v2/taxRates` |
| Service charges | `/config/v2/serviceCharges` |

Configuration collections are paginated. All snapshots are private; the public catalog is an allowlisted projection. Full menu/modifier/schedule/configuration payloads are retained only in private snapshots for later order validation. Variable prices display "Starting at:" when a supported minimum is known. Size-price minimums use the linked, online-visible size options; base and menu-specific prices use their resolved price. Zero and unknown prices are omitted instead of guessed. These are browse-only starting amounts, not authoritative checkout totals. Item stock is matched by multi-location ID when available; stock does not reserve inventory or establish modifier availability.

Stock and live availability expire after two minutes; daily sources become stale when their next 2am Central cycle begins. Customer refresh reads the cache and never calls Toast directly. Old menus may still be browsed with a warning; stale stock becomes unknown and has no item-level badge. Fresh positive quantities below 5 show **Low Stock**; quantities of 5 or more and confirmed unrestricted items show **In Stock**. Zero/negative quantities or an explicit out-of-stock status show **Out of Stock**. Invalid quantities stay unknown rather than making a stock claim. Exact inventory counts never appear in the public catalog. Out-of-stock items stay visible and their options remain browsable, but the item dialog's ordering link is replaced by a disabled action. Toast's separate hosted site remains responsible for its own stock enforcement. Future custom checkout must recheck stock server-side; a disabled UI alone is not order validation. `ONLINE` only describes Toast's receiving device, not whether the restaurant or menu is open. Ordering-hours enforcement is not implemented and checkout remains disabled regardless of source freshness.

## Automatic synchronization

| Sources | Schedule |
| --- | --- |
| Menus, dining options, ordering schedule, restaurant, tax rates, service charges | Once per daily cycle beginning at 2:00 AM America/Chicago |
| Stock and restaurant availability | Approximately every minute |

Supabase `pg_cron` runs `firehouse-toast-sync` every minute. A database function queues an HTTP request using `pg_net`; the Edge Function then selects only due sources. Daily timing follows Central daylight-saving changes. On the spring-forward day, when 2am does not exist, daily work starts at 3am. Missed or failed daily work is caught up after the due time, not silently skipped until tomorrow. The live-source due interval has a small timing allowance, and the two-minute freshness limit permits normal cron/network jitter. Polling and rate-limit pauses are not a guarantee of real-time inventory.

All Toast HTTP traffic in this integration, including authentication, discovery and pagination, goes through one database-backed worker lease and a request gate spaced at least 1.1 seconds apart. A run has a 45-second request budget and a 90-second crash-recovery lease. A source has a 30-second minimum manual refresh cooldown; different sources are independent. Manual requests do not bypass a running worker or a provider cooldown. `Retry-After` and Toast reset headers pause every worker; transient failures back off from one minute up to one hour, or longer if Toast requires it. Last successful snapshots survive failures. Other applications using the same Toast credentials can still consume shared quotas, so provider headers remain authoritative.

Toast authentication tokens are reused across cold starts. Only AES-GCM ciphertext and expiry are stored in the private `toast_auth_cache` table, encrypted with key material derived from the server's Supabase service key. Refresh attempts are throttled to at most once per 30 minutes for a credential set; normal operation reuses a token until shortly before its reported expiry. Rotating the service encryption key can invalidate the cache and require a new authentication attempt. No cached token, service key, or scheduler secret is returned by a public/staff API or written to diagnostic logs.

Deploy migrations `202610150003_sync_control.sql` and `202610150004_sync_scheduler.sql` before the updated function. The latter enables the platform extensions, creates a random scheduler credential in Supabase Vault, and installs the minute cron job. The deployed function registers its own trusted Supabase URL on its first non-OPTIONS request; no extra user-managed secret or GitHub Actions credential is needed. An initial public status/catalog request completes this setup. The cron command contains no credentials. The internal endpoint verifies the Vault credential independently of staff JWTs, and only the service role may call its verification/setup RPCs.

In **Toast Connection**, use a source's refresh icon to sync only that source or **Sync All** for a full refresh. The panel shows schedules, last fetch, retries/errors, provider cooldowns, and the scheduler's last enqueue time. Connection logs label actual attempts as Manual or Scheduled. Disabled retry controls refresh when their cooldown ends. Review Supabase Cron job history and `pg_net` responses if ticks stop; an enqueue timestamp alone is not proof that the HTTP worker succeeded. Successful per-source timestamps are the primary freshness check. Append-only sync logs also need a reviewed retention policy as volume grows.

Before production custom ordering, add signed webhooks, menu metadata checks, monitoring/alerts, and server-side validation of stale/unavailable sources. Scheduled polling does not replace those order-acceptance controls.

## Manage the website menu

After a successful menu sync, sign in as a manager with MFA and open **Menu** in the staff panel.

- Filter **Menus** or **Categories** to rename the labels used in the customer page's left navigation. Each menu appears once as a heading, with its categories underneath. Nested categories retain their parent category path.
- Select the edit icon beside any menu, category, item, modifier group, or modifier. Change its online name or enable **Hide on this site**, then save. Hidden parents remove their descendants from the public catalog. Filters keep hidden entities available to restore them.
- Items and modifiers support JPEG, PNG, and WebP uploads or an HTTPS photo URL. Uploaded photos are resized to a maximum dimension of 1600 pixels and re-encoded in the browser before transfer. The backend checks file signatures and enforces a 5 MB upload limit. SVG and other formats are not accepted.
- **Restore Toast Defaults** clears the edited name, hide setting, and custom photo when saved. Existing Toast photos are used when there is no custom photo. Saving affects the next customer menu load/refresh; another Toast sync is not required.
- Recent menu changes show the last 25 audited saves. Database audit rows retain the actor, timestamp, correlation ID, and before/after values. Shared modifier overrides affect that modifier wherever it appears in this location's menu.

Overrides are stored separately from Toast snapshots, scoped to the imported restaurant GUID, and keyed by entity type and multi-location ID when available (otherwise GUID). Toast sync does not overwrite them. A genuinely new Toast entity with a new stable ID does not inherit an old entity's override. Overrides can further restrict, but never expand, Toast's online channel visibility. The public catalog fails closed if override storage is unavailable.

The `menu-photos` Supabase Storage bucket is intentionally public: publish only product photos that can be viewed by anyone. Only the manager-authenticated Edge Function accepts uploads; browser clients have no direct Storage write policy. Uploaded but unsaved/replaced photos are not automatically deleted in this phase, so review storage usage and add an orphan-retention job as usage grows. External photo URLs cause customers' browsers to contact that image host; requests omit the page referrer.

These changes affect this website and its API/mobile catalog only. They do not rename or hide anything on Toast POS or Toast's hosted checkout. Customers open **View options** on an item to browse its modifiers in a dialog rather than expanding long lists inside menu cards. Groups are collapsible and show option counts, required/optional status, defaults, and selection limits. Groups with at least 10 options have search, including nested option matches, and bounded scrolling. The dialog supports keyboard closing and restores focus to the originating item button. Modifier details are browse-only, not a cart or a guarantee that a selection is orderable; checkout remains on Toast. Before custom ordering goes live, validate private Toast defaults and selection constraints and block any item whose required options have been hidden without a valid alternative.

New backend deployment requires migration `202610150002_menu_overrides.sql` before deploying the updated Edge Function. The migration creates the private override/audit tables, transactional save RPC, and photo bucket. It does not change Toast data or existing orders.

## Mobile reuse

The backend is independent of the website and is suitable for an Expo/React Native Android/iOS client. Reuse `shared/ordering-client.mjs`, its declarations, and `supabase/functions/_shared/contracts.ts`. The shared client has no DOM, window, or browser storage dependency. These are source modules in this repository, not yet a published npm package.

```typescript
import { createOrderingClient, type Catalog } from './shared/ordering-client.mjs';

const ordering = createOrderingClient({
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  supabasePublishableKey: 'YOUR_PUBLIC_KEY',
});
const catalog = await ordering.request<Catalog>('/catalog');
```

Native UI screens will still need to be built; the website's HTML/CSS is not a native app. Use platform-appropriate secure session storage and Supabase Auth/PKCE when adding native authentication. Do not place Toast credentials or service keys in an app bundle. API changes that break clients should use a new version so older installed apps continue to work.

## API surface

All responses use `{ apiVersion, requestId, data }` or `{ apiVersion, requestId, error: { code, message } }`. Use the response request ID to trace errors. Public endpoints accept a public project API key; staff endpoints additionally require the user's bearer token. Pagination is zero-based.

| Method | Path after `/v1` | Access |
| --- | --- | --- |
| GET | `/status` | Public freshness and read-only flags |
| GET | `/catalog` | Public menu projection; 503 before first successful menu sync |
| GET | `/staff/me` | Active staff; indicates manager MFA requirement |
| GET | `/staff/orders?page=0&status=failed` | Authorized staff; 25 per page |
| GET | `/staff/orders/{id}` | Authorized staff |
| GET | `/staff/orders/{id}/events?page=0` | Manager with MFA; latest 50 per page |
| GET | `/staff/integrations?page=0` | Manager with MFA; latest 50 per page |
| GET | `/staff/restaurants` | Manager with MFA; discover accessible Toast locations without a GUID |
| GET | `/staff/menu` | Manager with MFA; imported entities, overrides, and latest 25 menu-change events |
| POST | `/staff/menu/override` | Manager with MFA; validated JSON name, hide setting, photo URL |
| POST | `/staff/menu/photo?entity_type=item&entity_id=ml:ID` | Manager with MFA; image bytes and matching image Content-Type; returns a public photo URL |
| POST | `/staff/sync?source=stock` | Manager with MFA; one named source, or `all` (the default); Toast reads only |
| POST | `/internal/sync` | Vault scheduler credential in `x-sync-token`; due sources only; not a staff/browser endpoint |

## Before accepting orders or payments

- Confirm Toast ordering/write access, channel visibility, certification, and the supported payment encryption/tokenization flow. Order-write permission alone does not grant card-processing access.
- Implement nested modifiers, defaults, selection limits, quantity and pricing rules, taxes, service charges, dining-option mapping, schedules, holidays, timezone/DST, prep times, and fulfillment cutoffs. Compute authoritative totals on the server.
- Persist each checkout intent and its idempotency key before transmission. Add a durable outbox/queue, worker, timeouts, and reconciliation before retries; a timed-out request is not proof of rejection.
- Record payment authorization, Toast acceptance, capture/void/refund, confirmations, and fulfillment as separate events. Never confirm an order solely because an HTTP request completed.
- Capture origin IP only from a verified gateway/proxy source. Never trust a browser-submitted IP or blindly use the first forwarded header. No origin IP capture is implemented in this read-only phase.
- Define privacy notices and retention/deletion policies for IP addresses, user agents, customer data, and evidence. Add access auditing and controlled dispute exports. Supabase administrative/direct database reads are not fully audited by this application; the API records manager timeline views only.
- Never store PAN, CVV, passwords, session tokens, or raw payment/Toast payloads in order events. Add processor-approved authentication results and fulfillment evidence only through a sanitized server-side writer.
- Append-only triggers prevent routine event changes, not tampering by a database owner. Define a privileged, reviewed retention procedure and stronger external archival if required. Ordinary deletes are intentionally blocked.
- Complete production RLS/auth tests, restore drills, alerting, load tests, abuse protection, and live restaurant acceptance tests before enabling checkout.
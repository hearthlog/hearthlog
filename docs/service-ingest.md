# Service ingest

A way for something that is not a signed-in browser (an iPhone Shortcut first)
to write to one Ledger log as a named service identity. The first integration
logs daily steps. The design and its decisions are in
service-ingest-plan.md.

## How it works

```
Shortcut  PUT /api/integrations/v1/<id>/steps/<yyyy-mm-dd>   { "steps": 8421 }
          CF-Access-Client-Id / CF-Access-Client-Secret
  -> Cloudflare Access: application "<site> integrations" (host/api/integrations/*),
     Service Auth policy that admits only the integrations' service tokens
  -> frontend Worker (packages/cloudflare/src/integrations/): verifies the token again, maps its
     client id to one integration, builds the events, appends as service:<id>
  -> Ledger -> browsers receive the events like any other
```

- The integrations application has its own audience, so the service token is
  useless on `/api/ledger` and every other route. The main application's check
  (`authorizeStorRequest`) needs an allow-listed email, which a token never has.
- The caller sends a value, never an event. The Worker owns the event shape, so
  a leaked token can only set step totals for one log within the date window.
- Ledger has one principal per app, so the "service account" lives in the
  Worker. The author shown in Log history is `service:<integration id>`.

## Steps

`PUT /api/integrations/v1/<integration id>/steps/<yyyy-mm-dd>` with
`{ "steps": <whole number> }` sets that day's total. Repeating a request is
harmless.

| Status | Meaning |
| --- | --- |
| `200 { status: "created" \| "updated", date, steps }` | The day is saved |
| `400` | Not a whole number from 0 to 200000, bad JSON, or not a calendar day |
| `403` | No valid service token, or a browser (a request with an `Origin`) |
| `404` | The token belongs to a different integration, or none matches |
| `413` / `415` | Body over 1 KiB, or not `application/json` |
| `422` | The date is outside 14 days before to 1 day after the Worker's UTC today |
| `429` | Rate limited |
| `409` / `5xx` | The day changed under the update three times, or Ledger is unavailable; retry |

- One `activity_entry` per day on a deterministic id, `kind: "steps"`,
  `source: "<integration id>"`, logged at `00:00` of the date. A retry within
  the same minute is the same request to Ledger. Later calls append another
  update event; keep the automation to a few runs a day.
- Synced entries have no stored calories, because the Worker has no body
  weight. The read model estimates them from the weigh-in in force on that day
  (`modules/health/src/data/step-calories.ts`), so they count toward active energy once a
  weight is logged.
- A synced entry shows `Synced · <id>` and has no edit or delete in the
  Activity page: the next sync would overwrite an edit. Remove a wrong day
  through Log history.

## Set up an integration

1. **Find the log.** An integration writes to one log. Take its id from the
   log panel (or the Developer page) of the site.
2. **Add it to `tenants.json`** on the site:

   ```json
   "integrations": [
     { "id": "iphone-steps", "kind": "steps", "logId": "<log uuid>" }
   ]
   ```

   The site must enable the feature the kind needs (`activities` for steps).
   `pnpm check:tenants` validates the entry.
3. **Create the application and token** (needs `CLOUDFLARE_API_TOKEN` with
   "Access: Apps and Policies -> Edit" and "Access: Service Tokens -> Edit"):

   ```bash
   pnpm ensure:tenant -- --site alpha --create-integration-token iphone-steps --set-secret
   ```

   It creates the path-scoped Access application and the Service Auth policy,
   creates the token, and prints the client id and secret **once**. The secret
   cannot be read back and is never written to the repository. `--set-secret`
   also pushes the application's audience as `CF_ACCESS_INTEGRATIONS_AUD`.
4. **Set `clientId`** from the output on the integration in `tenants.json`.
   Until it is set the Worker ignores the integration.
5. **Deploy** the site so the Worker receives the integration list.

A token lasts one year (Cloudflare's default). Replace it by deleting the token
in Cloudflare Zero Trust (Access, Service Auth), then run step 3 again and
update the Shortcut and `clientId`. Removing an integration from `tenants.json`
removes its access on the next `ensure:tenant`.

### Verify the Access setup

Access evaluates the most specific application first, so the integrations
application should win over the site's application for `/api/integrations/*`.
After the first run check that a request with the token reaches the Worker
(`200`) and that the same token on any other path, for example
`/api/ledger/session`, is refused by Access.

## The Shortcut

1. **Find Health Samples** where Type is Steps and Start Date is Today.
2. **Calculate Statistics** on the samples: Sum. **Round** it to a whole number.
3. **Format Date** of Current Date with the custom format `yyyy-MM-dd`.
4. **Get Contents of URL**: URL
   `https://<site>/api/integrations/v1/iphone-steps/steps/<formatted date>`,
   Method `PUT`, Headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`,
   Request Body JSON with one field `steps` of type Number.
5. Two personal automations, set to run immediately without asking: about 22:00
   for today, and about 07:00 with Start Date set to Yesterday and the date
   shifted a day back, to settle yesterday's final total.

The client id and secret live in the Shortcut. Deleting the service token cuts
the phone off.

## Rate limit

When the `INTEGRATIONS_LIMITER` rate-limit binding is configured the Worker
refuses a client id above the limit with `429` before it writes. The limit is in
`packages/tooling/src/tenants/wrangler-base.ts`.

## Adding a kind

A kind is a small typed write; never expose a generic append.

1. Add the kind to `INTEGRATION_KINDS` and `INTEGRATION_KIND_FEATURE` in
   `packages/contracts/src/integrations/kinds.ts`.
2. Put the pure request validation and event construction in
   `src/lib/integrations/<kind>.ts` (no Svelte, no `$app/*`).
3. Add a case to `runKind` in `packages/cloudflare/src/integrations/index.ts` that parses the
   request and calls `upsertEntity` (create, or update from the version Ledger
   names) with a deterministic entity id.
4. Test the access boundary and the append in `modules/health/src/server/steps.test.ts` (the module's case) and `packages/cloudflare/src/service-access-auth.test.ts`.
